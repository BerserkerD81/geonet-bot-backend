import { AppDataSource } from '../datasource';
import { User } from '../models/User';
import bcrypt from 'bcryptjs';
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import { sendFailedLoginAlert, sendWelcomeWithPassword } from '../services/emailService';
import { sendPasswordChanged } from '../services/emailService';

export async function register(req: any, res: any) {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const repo = AppDataSource.getRepository(User);
  const existing = await repo.findOne({ where: { email } });
  if (existing) return res.status(400).json({ error: 'user exists' });

  const rounds = Number(process.env.BCRYPT_SALT_ROUNDS) || 10;
  const hash = await bcrypt.hash(password, rounds);
  // create user but do not log them in; 2FA is mandatory
  const user = repo.create({ email, passwordHash: hash, isTwoFactorEnabled: false, name });
  await repo.save(user);
  // Send credentials to the new user via email
  try {
    await sendWelcomeWithPassword(email, password, name);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('Failed to send welcome email:', e);
  }
  (req.session as any).pendingUserId = user.id;
  // instruct client to run 2FA setup next
  res.json({ ok: true, id: user.id, requires2fa: true });
}

export async function login(req: any, res: any) {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const repo = AppDataSource.getRepository(User);
  const user = await repo.findOne({ where: { email } });
  if (!user || !user.passwordHash) return res.status(401).json({ error: 'invalid credentials' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    try {
      await sendFailedLoginAlert(user.email!, user.name, { ip: req.ip, userAgent: req.get('user-agent') });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('Failed to send failed login alert:', e);
    }
    return res.status(401).json({ error: 'invalid credentials' });
  }
  // Enforce 2FA for all users. If user hasn't set up 2FA, keep them in pending state
  if (!user.isTwoFactorEnabled || !user.twoFactorSecret) {
    (req.session as any).pendingUserId = user.id;
    return res.json({ ok: true, requires2fa_setup: true, userId: user.id });
  }

  // user has 2FA enabled -> require token verification (pending)
  (req.session as any).pendingUserId = user.id;
  return res.json({ ok: true, requires2fa_verify: true, userId: user.id });
}

export async function login2fa(req: any, res: any) {
  const { userId, token } = req.body;
  if (!userId || !token) return res.status(400).json({ error: 'userId and token required' });

  const session = req.session as any;
  if (!session.pendingUserId || Number(session.pendingUserId) !== Number(userId)) {
    return res.status(401).json({ error: 'unauthenticated' });
  }

  const repo = AppDataSource.getRepository(User);
  const user = await repo.findOne({ where: { id: Number(userId) } });
  if (!user || !user.twoFactorSecret) return res.status(400).json({ error: 'invalid request' });

  const verified = speakeasy.totp.verify({ secret: user.twoFactorSecret, encoding: 'base32', token, window: 1 });
  if (!verified) return res.status(401).json({ error: 'invalid token' });
  // successful 2FA: mark enabled if not already, create full session
  if (!user.isTwoFactorEnabled) {
    user.isTwoFactorEnabled = true;
    await repo.save(user);
  }
  (req.session as any).userId = user.id;
  delete (req.session as any).pendingUserId;
  res.json({ ok: true });
}

export async function logout(req: any, res: any) {
  req.session?.destroy?.(() => {});
  res.json({ ok: true });
}

export async function me(req: any, res: any) {
  const session = req.session as any;
  const userId = session?.userId;
  const pendingUserId = session?.pendingUserId;
  if (!userId) {
    return res.json({ user: null, pendingUserId: pendingUserId || null });
  }
  const repo = AppDataSource.getRepository(User);
  const user = await repo.findOne({ where: { id: Number(userId) } });
  if (!user) return res.json({ user: null, pendingUserId: pendingUserId || null });
  return res.json({ user: { id: user.id, email: user.email, name: user.name, isTwoFactorEnabled: user.isTwoFactorEnabled }, pendingUserId: pendingUserId || null });
}

export async function setup2fa(req: any, res: any) {
  // allow setup when user is in pending state (after register/login) or fully authenticated
  const session = req.session as any;
  const userId = session.userId || session.pendingUserId;
  const repo = AppDataSource.getRepository(User);
  const user = await repo.findOne({ where: { id: Number(userId) } });
  if (!user) return res.status(401).json({ error: 'unauthenticated' });

  const secret = speakeasy.generateSecret({ length: 20 });
  user.twoFactorSecret = secret.base32;
  await repo.save(user);

  const otpauth = speakeasy.otpauthURL({ secret: secret.ascii, label: `geonet:${user.email}`, encoding: 'ascii' });
  const qr = await QRCode.toDataURL(otpauth);
  res.json({ qr, secret: secret.base32 });
}

export async function verify2fa(req: any, res: any) {
  const { token } = req.body;
  const session = req.session as any;
  const userId = session.userId || session.pendingUserId;
  const repo = AppDataSource.getRepository(User);
  const user = await repo.findOne({ where: { id: Number(userId) } });
  if (!user || !user.twoFactorSecret) return res.status(400).json({ ok: false });

  const verified = speakeasy.totp.verify({ secret: user.twoFactorSecret, encoding: 'base32', token, window: 1 });
  if (verified) {
    user.isTwoFactorEnabled = true;
    await repo.save(user);
    // complete login: move pending -> full session
    (req.session as any).userId = user.id;
    delete (req.session as any).pendingUserId;
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false });
}

export async function changePassword(req: any, res: any) {
  const session = req.session as any;
  if (!session?.userId) return res.status(401).json({ error: 'unauthenticated' });
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword and newPassword required' });
  if (typeof newPassword !== 'string' || newPassword.length < 8) return res.status(400).json({ error: 'password too short' });

  const repo = AppDataSource.getRepository(User);
  const user = await repo.findOne({ where: { id: Number(session.userId) } });
  if (!user || !user.passwordHash) return res.status(400).json({ error: 'invalid account' });

  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'invalid current password' });

  const rounds = Number(process.env.BCRYPT_SALT_ROUNDS) || 10;
  user.passwordHash = await bcrypt.hash(newPassword, rounds);
  await repo.save(user);

  try {
    if (user.email) await sendPasswordChanged(user.email, undefined, user.name);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('Failed to send password changed (self) email:', e);
  }
  return res.json({ ok: true });
}
