import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity()
export class User {
  @PrimaryGeneratedColumn('increment')
  id!: number;

  @Column({ unique: true, nullable: true })
  email?: string;

  @Column({ nullable: true })
  name?: string;

  @Column({ nullable: true })
  passwordHash?: string;

  @Column({ nullable: true })
  googleId?: string;

  @Column({ nullable: true })
  twoFactorSecret?: string;

  @Column({ default: false })
  isTwoFactorEnabled!: boolean;
}
