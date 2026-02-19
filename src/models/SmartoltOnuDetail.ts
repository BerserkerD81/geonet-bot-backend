import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity()
export class SmartoltOnuDetail {
  @PrimaryGeneratedColumn()
  id!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @Index()
  @Column({ type: 'datetime' })
  capturedAt!: Date;

  @Index()
  @Column({ type: 'varchar', length: 128, nullable: true })
  uniqueExternalId?: string | null;

  @Index()
  @Column({ type: 'varchar', length: 128, nullable: true })
  sn?: string | null;

  @Index()
  @Column({ type: 'varchar', length: 45, nullable: true })
  ipAddress?: string | null;

  @Index()
  @Column({ type: 'varchar', length: 255, nullable: true })
  name?: string | null;

  @Column({ type: 'simple-json', nullable: true })
  payload?: any;
}
