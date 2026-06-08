import 'reflect-metadata';
import express from 'express';
import session from 'express-session';
import dotenv from 'dotenv';
import helmet from 'helmet';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import rateLimit from 'express-rate-limit';

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
import wizardRoutes from './routes/wizard';

// Servicios y Scripts
import { ensureDefaultAdmin } from './services/adminBootstrap';
import { migrateOldMessagesToSessions } from './scripts/migrateSessions';
import { refreshZoneOdbCache } from './services/zoneOdbCache';
import { scheduleSmartoltOnuSnapshots } from './services/smartoltOnuSnapshot';

dotenv.config();

const app = express();

// --- CONFIANZA EN NGINX PROXY MANAGER ---
// Fundamental para que la cookie 'secure: true' funcione detrás del proxy HTTP interno
app.set('trust proxy', 1);

// --- SEGURIDAD Y MIDDLEWARES (HELMET) ---
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

// --- RATE LIMITING (Protección contra fuerza bruta y DDoS) ---
const globalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minutos
  max: 150, // Límite de 150 peticiones por IP cada 15 minutos
  message: { error: 'Demasiadas peticiones desde esta IP, intenta más tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/', globalLimiter);

// --- CONFIGURACIÓN ESTRICTA DE CORS ---
const allowedOrigins = [
  'https://smart.geonet.cl', 
  'http://localhost:5173', // Solo para entorno de desarrollo local
  'http://127.0.0.1:5173'
];

app.use(cors({
  origin: function (origin, callback) {
    // Permitir peticiones sin origen (como Postman, curl o procesos internos del servidor)
    if (!origin) return callback(null, true);
    
    // Verificar si el origen está en la lista blanca
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('No permitido por CORS'));
    }
  },
  credentials: true, // Vital para permitir el envío/recepción de cookies de sesión
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// --- PARSERS ---
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --- SESIONES BLINDADAS ---
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'secret_super_seguro',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: (process.env.SESSION_COOKIE_SECURE || '').toLowerCase() === 'true'
        || process.env.NODE_ENV === 'production', // true en producción (HTTPS), configurable por env
      httpOnly: true, // Inmune a lectura mediante JavaScript (XSS)
      sameSite: 'strict', // Solo viaja si la petición ocurre dentro de tu dominio
      maxAge: 1000 * 60 * 60 * 24 // 1 día de duración
    }
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
app.use('/odb', odbRoutes); 
app.use('/admin', adminRoutes);
app.use('/installations', installationsRoutes);
app.use('/wizard', wizardRoutes);

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
        fullSyncClients().catch((e) => console.error('Hourly WispHub sync failed', (e as any)?.message || e));
        fullSyncInstallations().catch((e) => console.error('Hourly Installations sync failed', (e as any)?.message || e));
      }, 60 * 60 * 1000);

    } catch (e) { 
      console.warn('Sync scheduler failed', e); 
    }

    // 3.1. SmartOLT ONU snapshot diario
    try {
      scheduleSmartoltOnuSnapshots();
    } catch (e) {
      console.warn('SmartOLT ONU snapshot scheduler failed', e);
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

// Shutdown hooks: cerrar conexión compartida a Browserless si existe
import('./services/wisphubClient').then(mod => {
  const shutdown = async () => {
    try {
      await mod.shutdownBrowser();
      console.log('[Shutdown] Browserless connection closed.');
    } catch (e: any) {
      console.warn('[Shutdown] Error closing browser:', e?.message || e);
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('beforeExit', async () => { await mod.shutdownBrowser(); });
}).catch(() => {});