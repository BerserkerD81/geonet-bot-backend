import 'reflect-metadata';
import express from 'express';
import session from 'express-session';
import dotenv from 'dotenv';
import helmet from 'helmet';
import cors from 'cors';
import path from 'path';
import fs from 'fs';

// Data Source y Rutas
import { AppDataSource } from './datasource';
import authRoutes from './routes/auth';
import adminRoutes from './routes/admin';
import chatRoutes from './routes/chat';
import clientsRoutes from './routes/clients';
import integrationsRoutes from './routes/integrations';
import installationsRoutes from './routes/installations';
import smartoltRoutes from './routes/smartolt';
import odbRoutes from './routes/odb';

// Servicios y Scripts
import { ensureDefaultAdmin } from './services/adminBootstrap';
import { migrateOldMessagesToSessions } from './scripts/migrateSessions';
import { refreshZoneOdbCache } from './services/zoneOdbCache';

dotenv.config();

const app = express();

// --- SEGURIDAD Y MIDDLEWARES ---
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'secret_super_seguro',
    resave: false,
    saveUninitialized: false
  })
);

// --- CONFIGURACIÓN DE CARPETAS DE UPLOADS ---
const uploadsPath = path.resolve(process.cwd(), 'uploads');
const chatUploadsPath = path.join(uploadsPath, 'chat');

if (!fs.existsSync(uploadsPath)) {
    console.log(`📂 Creando carpeta base: ${uploadsPath}`);
    fs.mkdirSync(uploadsPath, { recursive: true });
}
if (!fs.existsSync(chatUploadsPath)) {
    console.log(`📂 Creando carpeta chat: ${chatUploadsPath}`);
    fs.mkdirSync(chatUploadsPath, { recursive: true });
}

// Servir archivos estáticos
app.use('/uploads', express.static(uploadsPath));
console.log(`📡 Sirviendo archivos estáticos desde: ${uploadsPath}`);

// --- RUTAS DE API ---
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

// --- INICIALIZACIÓN DEL SERVIDOR Y TAREAS INICIALES ---
AppDataSource.initialize()
  .then(async () => {
    console.log('📦 Database connected successfully');

    // 1. Tareas críticas de integridad y Cache (Al arrancar)
    try {
      await ensureDefaultAdmin();
      
      // ACTUALIZACIÓN DE SMARTOLT (Zonas y ODBs)
      console.log('🔄 Actualizando Zonas y ODBs desde SmartOLT...');
      await refreshZoneOdbCache();
      console.log('✅ Cache de SmartOLT sincronizada.');

      await migrateOldMessagesToSessions(); 
      console.log('✅ Verificación de integridad de sesiones completada.');
    } catch (e) {
      console.error('❌ Error durante las tareas de inicialización:', e);
    }

    // 2. Sistema de Limpieza Automática de Imágenes (Garbage Collector)
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

    // Ejecutar limpieza a los 10 segundos y luego cada 24 horas
    setTimeout(limpiarImagenesViejas, 10000);
    setInterval(limpiarImagenesViejas, 24 * 60 * 60 * 1000);

    // 3. Programación de Sincronizaciones Externas (WispHub y Otros)
    try {
      const { fullSyncClients } = await import('./services/wisphubClient');
      const { fullSyncInstallations } = await import('./services/wisphubInstallations');
      const syncRawToColumns = (await import('./scripts/syncRawToColumns')).default;

      // Sincronizaciones iniciales escalonadas para no saturar
      setTimeout(() => { fullSyncClients().catch(() => {}); }, 15000);
      setTimeout(() => { fullSyncInstallations().catch(() => {}); }, 30000);
      setTimeout(() => { syncRawToColumns().catch(() => {}); }, 45000);

      // Sincronización horaria
      setInterval(() => {
        fullSyncClients().catch((e) => console.error('Hourly WispHub sync failed', e?.message));
        fullSyncInstallations().catch((e) => console.error('Hourly Installations sync failed', e?.message));
      }, 60 * 60 * 1000);

    } catch (e) { 
      console.warn('Sync scheduler failed', e); 
    }
    
    // 4. Iniciar escucha
    app.listen(port, () => {
        console.log(`🚀 Server listening on port ${port}`);
        console.log(`📂 CARPETA CHAT: ${chatUploadsPath}`);
    });
  })
  .catch((err) => {
    console.error('DataSource init error', err);
    process.exit(1);
  });