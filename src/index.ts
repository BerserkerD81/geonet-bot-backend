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
app.use(express.json({ limit: '20mb' })); 
app.use(express.urlencoded({ limit: '20mb', extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'secret_super_seguro',
    resave: false,
    saveUninitialized: false
  })
);

// --- RUTAS Y CARPETAS ---
const uploadsPath = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsPath)) {
    console.log(`📂 Creando carpeta uploads en: ${uploadsPath}`);
    fs.mkdirSync(uploadsPath, { recursive: true });
}

// Servir archivos estáticos
app.use('/uploads', express.static(uploadsPath));

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

    // -------------------------------------------------------------
    // 🧹 SISTEMA DE LIMPIEZA AUTOMÁTICA (GARBAGE COLLECTOR)
    // -------------------------------------------------------------
    const limpiarImagenesViejas = () => {
      // Apuntamos específicamente a la subcarpeta 'chat' donde guardas las evidencias
      const chatDir = path.join(uploadsPath, 'chat');
      const diasVida = 30; // Configuración: Borrar fotos de más de 30 días
      
      if (!fs.existsSync(chatDir)) return;

      fs.readdir(chatDir, (err, files) => {
        if (err) return console.error('⚠️ Error leyendo carpeta de limpieza:', err);

        const now = Date.now();
        const millisVida = diasVida * 24 * 60 * 60 * 1000;
        let contador = 0;

        files.forEach((file) => {
          const filePath = path.join(chatDir, file);
          fs.stat(filePath, (err, stats) => {
            if (err) return;
            // Si la fecha de modificación es más vieja que el límite
            if (now - stats.mtimeMs > millisVida) {
              fs.unlink(filePath, (unlinkErr) => {
                if (!unlinkErr) {
                  contador++;
                  // Log opcional para ver qué se borra (puedes comentarlo)
                  // console.log(`🗑️ Borrado archivo antiguo: ${file}`);
                }
              });
            }
          });
        });
        // Nota: El console.log de abajo podría salir antes de terminar de borrar por asincronía, 
        // pero sirve como aviso general.
        if (files.length > 0) console.log(`🧹 Tarea de limpieza ejecutada en ${chatDir}`);
      });
    };

    // 1. Ejecutar limpieza 10 segundos después de iniciar el servidor
    setTimeout(limpiarImagenesViejas, 10000);

    // 2. Programar limpieza cada 24 horas
    setInterval(limpiarImagenesViejas, 24 * 60 * 60 * 1000);
    // -------------------------------------------------------------


    // Inits de servicios y sincronización WispHub
    try {
      await refreshZoneOdbCache().catch((e) => console.error('Cache init failed', e));
      const { fullSyncClients } = await import('./services/wisphubClient');
      const { fullSyncInstallations } = await import('./services/wisphubInstallations');
      const syncRawToColumns = (await import('./scripts/syncRawToColumns')).default;

      // Syncs iniciales
      setTimeout(() => { fullSyncClients().catch(() => {}); }, 1000);
      setTimeout(() => { fullSyncInstallations().catch(() => {}); }, 2000);
      setTimeout(() => { syncRawToColumns().catch(() => {}); }, 5000);

      // Cron Jobs (Cada hora)
      setInterval(() => {
        fullSyncClients().catch((e) => console.error('Hourly WispHub sync failed', e?.message));
      }, 60 * 60 * 1000);
      
      setInterval(() => {
        fullSyncInstallations().catch((e) => console.error('Hourly Installations sync failed', e?.message));
      }, 60 * 60 * 1000);

    } catch (e) { console.warn('Sync scheduler failed', e); }
    
    app.listen(port, () => {
        console.log(`🚀 Server listening on port ${port}`);
        console.log(`📂 Serving uploads from: ${uploadsPath}`);
    });
  })
  .catch((err) => {
    console.error('DataSource init error', err);
    process.exit(1);
  });