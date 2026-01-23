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

dotenv.config();

const app = express();
app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'replace_me',
    resave: false,
    saveUninitialized: false
  })
);


// Static files for uploaded chat images
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

app.use('/auth', authRoutes);
app.use('/chat', chatRoutes);
app.use('/clients', clientsRoutes);
app.use('/integrations', integrationsRoutes);

app.use('/smartolt', smartoltRoutes);
app.use('/api', odbRoutes); // Expose ODB available ports endpoint at /api/odbs/:externalId/ports

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/health/email', async (req, res) => {
  const result = await verifyTransport();
  if ((result as any).ok) return res.json({ ok: true });
  return res.status(500).json(result);
});

const port = Number(process.env.PORT) || 3000;

AppDataSource.initialize()
  .then(async () => {
    await ensureDefaultAdmin();
    // Schedule hourly clients sync from WispHub
    try {
      const { fullSyncClients } = await import('./services/wisphubClient');
      const { fullSyncInstallations } = await import('./services/wisphubInstallations');
      const syncRawToColumns = (await import('./scripts/syncRawToColumns')).default;
      // Cachear zonas/ODBs al arrancar para tener las listas listas antes de autorizar
      await refreshZoneOdbCache().catch((e) => console.error('Cache zonas/ODB falló al iniciar', e));
      // Semanal
      setInterval(() => {
        refreshZoneOdbCache().catch((e) => console.error('Cache semanal zonas/ODB falló', e));
      }, 7 * 24 * 60 * 60 * 1000);
      // Initial sync in background
      setTimeout(() => { fullSyncClients().catch(() => {}); }, 1000);
      // Initial installations sync in background
      setTimeout(() => { fullSyncInstallations().catch(() => {}); }, 2_000);
      // Run raw->columns sync automatically once on startup
      setTimeout(() => { syncRawToColumns().catch((e: any) => console.error('syncRawToColumns failed', e?.message || e)); }, 5_000);
      // Every hour
      setInterval(() => {
        fullSyncClients().catch((e) => console.error('Hourly WispHub sync failed', e?.message || e));
      }, 60 * 60 * 1000);
      // Installations hourly
      setInterval(() => {
        fullSyncInstallations().catch((e) => console.error('Hourly WispHub installations sync failed', e?.message || e));
      }, 60 * 60 * 1000);
    } catch (e) {
      console.warn('WispHub sync scheduler not started:', (e as any)?.message);
    }
    app.listen(port, () => console.log(`Server listening on ${port}`));
  })
  .catch((err) => {
    console.error('DataSource init error', err);
    process.exit(1);
  });

app.use('/admin', adminRoutes);
app.use('/installations', installationsRoutes);
