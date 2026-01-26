import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { SmartoltOlt } from './SmartoltOlt';

@Entity('smartolt_vlan')
export class SmartoltVlan {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  externalId?: string | null; // VLAN id from SmartOLT

  @Column({ type: 'varchar', length: 255, nullable: true })
  name?: string | null;

  @Column({ type: 'datetime' })
  collectedAt!: Date;

  @ManyToOne(() => SmartoltOlt, (olt) => olt.vlans, { eager: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'olt_id' })
  olt!: SmartoltOlt;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
