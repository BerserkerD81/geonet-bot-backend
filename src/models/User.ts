import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity()
export class User {
  @PrimaryGeneratedColumn('increment')
  id!: number;

  @Column('varchar', { length: 255, unique: true, nullable: true })
  email?: string;

  @Column('varchar', { length: 255, nullable: true })
  name?: string;

  @Column('varchar', { length: 255, nullable: true })
  passwordHash?: string;

  @Column('varchar', { length: 255, nullable: true })
  googleId?: string;

  @Column('varchar', { length: 255, nullable: true })
  twoFactorSecret?: string;

  @Column('boolean', { default: false })
  isTwoFactorEnabled!: boolean;

  @Column('varchar', { length: 32, default: 'user' })
  role!: 'user' | 'admin';
}
