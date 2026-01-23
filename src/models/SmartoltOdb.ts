import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { SmartoltZone } from './SmartoltZone';

@Entity('smartolt_odb')
export class SmartoltOdb {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  externalId?: string | null;

  @Column({ type: 'datetime' })
  collectedAt!: Date;

  @ManyToOne(() => SmartoltZone, (zone) => zone.odbs, { eager: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'zone_id' })
  zone!: SmartoltZone;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
