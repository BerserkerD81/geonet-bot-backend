import { AppDataSource } from '../datasource'; // Tu conexión
import { ChatMessage } from '../models/ChatMessage';
import { ChatSession } from '../models/ChatSession';
import { IsNull } from 'typeorm';

export async function migrateOldMessagesToSessions() {
  const msgRepo = AppDataSource.getRepository(ChatMessage);
  const sessionRepo = AppDataSource.getRepository(ChatSession);

  console.log("🔄 Iniciando migración de chats viejos...");

  // 1. Obtener mensajes que NO tienen sesión asignada (los viejos)
  const orphanMessages = await msgRepo.find({
    where: { sessionId: IsNull() },
    order: { userId: 'ASC', createdAt: 'ASC' } // Orden vital para la lógica de tiempo
  });

  if (orphanMessages.length === 0) {
    console.log("✅ No hay mensajes pendientes de migrar.");
    return;
  }

  console.log(`📂 Procesando ${orphanMessages.length} mensajes huérfanos...`);

  let currentSession: ChatSession | null = null;
  const TIMEOUT_MS = 60 * 60 * 1000; // 1 Hora

  for (let i = 0; i < orphanMessages.length; i++) {
    const msg = orphanMessages[i];
    
    // Miramos el mensaje anterior en el array (si existe)
    // Nota: Como ordenamos por userId, si cambia el userId, el previousMsg no sirve de comparación directa
    const prevMsg = i > 0 ? orphanMessages[i - 1] : null;

    // Detectamos si necesitamos crear una sesión nueva
    let shouldCreateNewSession = false;

    if (!currentSession) {
      shouldCreateNewSession = true;
    } else if (prevMsg) {
       // 1. Si cambiamos de usuario
       if (msg.userId !== prevMsg.userId) shouldCreateNewSession = true;
       // 2. Si pasó más de 1 hora entre mensajes del mismo usuario
       else {
         const timeDiff = new Date(msg.createdAt).getTime() - new Date(prevMsg.createdAt).getTime();
         if (timeDiff > TIMEOUT_MS) shouldCreateNewSession = true;
       }
    }

    if (shouldCreateNewSession) {
      // Usar el contenido del mensaje como título (cortado a 50 caracteres)
      const titlePreview = (msg.content || 'Chat sin texto').substring(0, 50) + '...';
      
      currentSession = sessionRepo.create({
        userId: msg.userId,
        title: titlePreview,
        createdAt: msg.createdAt // La sesión nace con el primer mensaje
      });
      
      // Guardamos la sesión para obtener su ID
      await sessionRepo.save(currentSession);
    }

    // Asignamos el mensaje a la sesión actual
    if (currentSession) {
        msg.session = currentSession;
        msg.sessionId = currentSession.id;
        // Guardamos el mensaje actualizado
        await msgRepo.save(msg);
    }
  }

  console.log("🚀 ¡Migración Completada! Ahora todos tus mensajes tienen sesión.");
}