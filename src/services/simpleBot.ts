import { AppDataSource } from '../datasource';
import { Installation } from '../models/Installation';

export type SuggestedAction = {
  id: string;
  type: 'button' | 'input';
  label: string;
  payload?: string;
  placeholder?: string;
  helperText?: string;
  options?: string[];
};

/**
 * Obtiene instalaciones pendientes directamente de la BD para respuestas rápidas
 */
async function getPendingInstallations() {
  try {
    const repo = AppDataSource.getRepository(Installation);
    // Ajusta el filtro 'estado' según como guardes tus datos ('Instalación', 'Pendiente', etc.)
    const rows = await repo.find({ where: { estado_instalacion: 'Pendiente' }, take: 5 });
    
    return rows.map((inst: any) => ({
      clientName: inst.nombre || '',
      address: inst.direccion || '',
      status: inst.estado_instalacion || 'Pendiente',
      rut: inst.cedula || '',
      id: inst.id
    }));
  } catch (error) {
    console.error("Error en simpleBot getPendingInstallations:", error);
    return [];
  }
}

/**
 * Genera el texto de respuesta basado en palabras clave
 */
async function getMockResponse(userMessage: string): Promise<string> {
  const lowerMessage = userMessage.toLowerCase();

  // 1. Instalaciones Pendientes
  if (
    lowerMessage.includes('instalaciones pendientes') ||
    lowerMessage.includes('instalacion pendiente') ||
    lowerMessage.includes('instalación pendiente')
  ) {
    const installations = await getPendingInstallations();
    if (!installations.length) {
      return 'No hay instalaciones pendientes de evidencia para autorizar el alta en este momento.';
    }
    const list = installations
      .map(
        (inst, idx) =>
          `${idx + 1}. ${inst.clientName} (ID: ${inst.id}) - ${inst.address}`
      )
      .join('\n');
    return `Instalaciones pendientes encontradas:\n\n${list}`;
  }

  // 2. Ayuda de Alta
  if (lowerMessage.includes('alta') || lowerMessage.includes('nuevo cliente') || (lowerMessage.includes('instalación') && !lowerMessage.includes('pendiente'))) {
    return `Asistente SmartOLT - Alta de cliente:\n\nPuedo ayudarte a validar que la instalación está lista. Normalmente revisamos:\n\n1) Datos del cliente (nombre, documento)\n2) ONT registrada (SN correcto)\n3) Puerto OLT disponible\n4) Potencia óptica\n\nDime qué te falta y te guío.`;
  }

  // 3. Estado ONT/OLT
  if (lowerMessage.includes('ont') || lowerMessage.includes('olt') || lowerMessage.includes('potencia')) {
    return `Asistente SmartOLT - Estado:\n\nPara revisar un cliente comprueba:\n- Estado ONT (online/offline)\n- Potencia RX\n- Puerto PON\n- Alarmas\n\nIndícame un ID o SN para revisar.`;
  }

  // 4. Checklists
  if (lowerMessage.includes('revisar') || lowerMessage.includes('validar') || lowerMessage.includes('checklist')) {
    return `Checklist de instalación:\n\n- [ ] ONT energizada (Luz PON fija)\n- [ ] Potencia óptica en rango\n- [ ] Conectores limpios\n- [ ] SN registrado en SmartOLT\n- [ ] Evidencias subidas\n\n¿Todo listo?`;
  }

  // Default
  return `Soy tu asistente para SmartOLT.\n\nPuedo ayudarte con:\n- "Buscar cliente Juan"\n- "Instalaciones pendientes"\n- "Checklist de instalación"\n- "Autorizar ONU"`;
}

/**
 * Genera botones sugeridos basados en palabras clave
 */
async function getSuggestedActions(userMessage: string): Promise<SuggestedAction[]> {
  const lower = userMessage.toLowerCase();
  const actions: SuggestedAction[] = [];

  if (
    lower.includes('instalaciones pendientes') ||
    lower.includes('instalacion pendiente')
  ) {
    const installations = await getPendingInstallations();

    // Acciones globales
    actions.push({
      id: 'update-installations',
      type: 'button',
      label: '🔄 Actualizar lista',
      payload: 'Enséñame las instalaciones pendientes de evidencia para autorizar el alta'
    });

    // Botones para cada instalación encontrada
    installations.forEach(inst => {
      actions.push({
        id: `select-inst-${inst.id}`,
        type: 'button',
        label: `Seleccionar ${inst.clientName}`,
        payload: `seleccionar instalación ${inst.id}`
      });
    });
  } else if (lower.includes('alta') || lower.includes('nuevo cliente')) {
     actions.push({ id: 'search-mode', type: 'button', label: 'Buscar Cliente', payload: 'modo busqueda general' });
  }

  return actions;
}

/**
 * Función principal exportada que usa el chatController
 */
export async function buildStructuredResponse(userMessage: string): Promise<{ content: string; actions: SuggestedAction[] }> {
  const content = await getMockResponse(userMessage);
  const actions = await getSuggestedActions(userMessage);
  return { content, actions };
}