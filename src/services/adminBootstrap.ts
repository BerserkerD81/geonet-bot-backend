import bcrypt from 'bcryptjs';
import { AppDataSource } from '../datasource';
import { User } from '../models/User';

export async function ensureDefaultAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn('ADMIN_EMAIL/ADMIN_PASSWORD not set; no default admin created.');
    return;
  }

  const repo = AppDataSource.getRepository(User);
  const existing = await repo.findOne({ where: { email } });
  if (existing) return;

  const rounds = Number(process.env.BCRYPT_SALT_ROUNDS) || 10;
  const hash = await bcrypt.hash(password, rounds);
  const admin = repo.create({ email, passwordHash: hash, role: 'admin', isTwoFactorEnabled: false });
  await repo.save(admin);
  console.log(`Default admin created: ${email}`);
}
