import { AppDataSource } from '../datasource';
import { User } from '../models/User';
import bcrypt from 'bcryptjs';

export async function listUsers(req: any, res: any) {
  const repo = AppDataSource.getRepository(User);
  const users = await repo.find({ select: ['id', 'email', 'name', 'role', 'isTwoFactorEnabled'] });
  res.json({ users });
}

export async function createUser(req: any, res: any) {
  const { email, password, role = 'user' } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'invalid role' });

  const repo = AppDataSource.getRepository(User);
  const existing = await repo.findOne({ where: { email } });
  if (existing) return res.status(400).json({ error: 'user exists' });

  const rounds = Number(process.env.BCRYPT_SALT_ROUNDS) || 10;
  const hash = await bcrypt.hash(password, rounds);
  const { name } = req.body; // New line to extract name
  const user = repo.create({ email, passwordHash: hash, role, isTwoFactorEnabled: false, name }); // Include name in user creation
  await repo.save(user);
  res.json({ ok: true, id: user.id, requires2fa: true });
}

export async function updateUser(req: any, res: any) {
  const { id } = req.params;
  const { email, password, role, isTwoFactorEnabled } = req.body;
  const repo = AppDataSource.getRepository(User);
  const user = await repo.findOne({ where: { id: Number(id) } });
  if (!user) return res.status(404).json({ error: 'not found' });

  if (email) user.email = email;
  if (role) {
    if (!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'invalid role' });
    user.role = role;
  }
  if (typeof isTwoFactorEnabled === 'boolean') {
    user.isTwoFactorEnabled = isTwoFactorEnabled;
  }
  if (password) {
    const rounds = Number(process.env.BCRYPT_SALT_ROUNDS) || 10;
    user.passwordHash = await bcrypt.hash(password, rounds);
    // reset 2FA if password is reset by admin
    user.twoFactorSecret = null as any;
    user.isTwoFactorEnabled = false;
  }
  if (req.body.name) user.name = req.body.name; // New line to update name
  await repo.save(user);
  res.json({ ok: true });
}

export async function deleteUser(req: any, res: any) {
  const { id } = req.params;
  const repo = AppDataSource.getRepository(User);

  const user = await repo.findOne({ where: { id: Number(id) } });
  if (!user) return res.status(404).json({ error: 'not found' });

  await repo.remove(user);
  return res.json({ ok: true });
}
