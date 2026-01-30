import 'reflect-metadata';
import express from 'express';
import session from 'express-session';
import dotenv from 'dotenv';
import helmet from 'helmet';
import cors from 'cors';
import path from 'path';
import { AppDataSource } from './datasource';
import authRoutes from './routes/auth';
import adminRoutes from './routes/admin';
import chatRoutes from './routes/chat';
import clientsRoutes from './routes/clients';
import integrationsRoutes from './routes/integrations';
import installationsRoutes from './routes/installations';
import smartoltRoutes from './routes/smartolt';
import odbRoutes from './routes/odb';
import { ensureDefaultAdmin } from './services/adminBootstrap';
import { verifyTransport } from './services/emailService';
import { migrateOldMessagesToSessions } from './scripts/migrateSessions'; // <--- Importa la función
import { refreshZoneOdbCache } from './services/zoneOdbCache';
import fs from 'fs';

dotenv.config();

const app = express();

// --- SEGURIDAD: Permitir carga de imágenes ---
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }, 
  })
);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' })); // Aumentado por si envían fotos 4K
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'secret_super_seguro',
    resave: false,
    saveUninitialized: false
  })
);

// --- CONFIGURACIÓN DE CARPETAS DE UPLOADS (CRÍTICO) ---
// Usamos path.resolve para obtener la ruta absoluta real del sistema
const uploadsPath = path.resolve(process.cwd(), 'uploads');
const chatUploadsPath = path.join(uploadsPath, 'chat');

// Asegurar que las carpetas existen al iniciar
if (!fs.existsSync(uploadsPath)) {
    console.log(`📂 Creando carpeta base: ${uploadsPath}`);
    fs.mkdirSync(uploadsPath, { recursive: true });
}
if (!fs.existsSync(chatUploadsPath)) {
    console.log(`📂 Creando carpeta chat: ${chatUploadsPath}`);
    fs.mkdirSync(chatUploadsPath, { recursive: true });
}

// Servir archivos estáticos
// Mapea la URL "/uploads" -> Carpeta física "c:\tu-proyecto\uploads"
app.use('/uploads', express.static(uploadsPath));

// Log de depuración para verificar rutas al arrancar
console.log(`📡 Sirviendo archivos estáticos desde: ${uploadsPath}`);

// Rutas de API
app.use('/auth', authRoutes);
app.use('/chat', chatRoutes);
app.use('/clients', clientsRoutes);
app.use('/integrations', integrationsRoutes);
app.use('/smartolt', smartoltRoutes);
app.use('/api', odbRoutes); 
app.use('/admin', adminRoutes);
app.use('/installations', installationsRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT) || 3000;

// --- INICIALIZACIÓN DEL SERVIDOR ---
AppDataSource.initialize()
  .then(async () => {
    await ensureDefaultAdmin();
    try {
      // Esto solo hará algo si encuentra mensajes con sessionId en NULL
      await migrateOldMessagesToSessions(); 
      console.log('✅ Verificación de integridad de sesiones completada.');
    } catch (e) {
      console.error('❌ Error durante la migración de sesiones:', e);
    }

    // -------------------------------------------------------------
    // 🧹 SISTEMA DE LIMPIEZA AUTOMÁTICA (GARBAGE COLLECTOR)
    // -------------------------------------------------------------
    const limpiarImagenesViejas = () => {
      const diasVida = 30; 
      
      if (!fs.existsSync(chatUploadsPath)) return;

      fs.readdir(chatUploadsPath, (err, files) => {
        if (err) return console.error('⚠️ Error leyendo carpeta de limpieza:', err);

        const now = Date.now();
        const millisVida = diasVida * 24 * 60 * 60 * 1000;
        let contador = 0;

        files.forEach((file) => {
          const filePath = path.join(chatUploadsPath, file);
          fs.stat(filePath, (err, stats) => {
            if (err) return;
            if (now - stats.mtimeMs > millisVida) {
              fs.unlink(filePath, (unlinkErr) => {
                if (!unlinkErr) contador++;
              });
            }
          });
        });
      });
    };

    setTimeout(limpiarImagenesViejas, 10000);
    setInterval(limpiarImagenesViejas, 24 * 60 * 60 * 1000);

    // Inits de servicios y sincronización
    try {
      await refreshZoneOdbCache().catch((e) => console.error('Cache init failed', e));
      const { fullSyncClients } = await import('./services/wisphubClient');
      const { fullSyncInstallations } = await import('./services/wisphubInstallations');
      const syncRawToColumns = (await import('./scripts/syncRawToColumns')).default;

      setTimeout(() => { fullSyncClients().catch(() => {}); }, 1000);
      setTimeout(() => { fullSyncInstallations().catch(() => {}); }, 2000);
      setTimeout(() => { syncRawToColumns().catch(() => {}); }, 5000);

      setInterval(() => {
        fullSyncClients().catch((e) => console.error('Hourly WispHub sync failed', e?.message));
      }, 60 * 60 * 1000);
      
      setInterval(() => {
        fullSyncInstallations().catch((e) => console.error('Hourly Installations sync failed', e?.message));
      }, 60 * 60 * 1000);

    } catch (e) { console.warn('Sync scheduler failed', e); }
    
    app.listen(port, () => {
        console.log(`🚀 Server listening on port ${port}`);
        console.log(`📂 VERIFICAR CARPETA DE FOTOS: ${chatUploadsPath}`); // <--- Verifica esta ruta en tu consola
    });
  })
  .catch((err) => {
    console.error('DataSource init error', err);
    process.exit(1);
  });