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
import { ensureDefaultAdmin } from './services/adminBootstrap';
import { verifyTransport } from './services/emailService';

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
    app.listen(port, () => console.log(`Server listening on ${port}`));
  })
  .catch((err) => {
    console.error('DataSource init error', err);
    process.exit(1);
  });

app.use('/admin', adminRoutes);
