import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity()
export class SmartoltOnuSnapshot {
  @PrimaryGeneratedColumn()
  id!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @Index()
  @Column({ type: 'datetime' })
  capturedAt!: Date;

  @Column({ type: 'int', default: 0 })
  count!: number;

  @Column({ type: 'longtext', nullable: true })
  payload?: string | null;
}
