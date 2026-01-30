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

  // --- NUEVOS CAMPOS QUE VIENEN EN TU API ---
  
  // Mapeado desde "nr_of_ports"
  @Column({ type: 'int', nullable: true })
  ports?: number | null;

  // Mapeado desde "latitude"
  @Column({ type: 'varchar', length: 50, nullable: true })
  latitude?: string | null;

  // Mapeado desde "longitude"
  @Column({ type: 'varchar', length: 50, nullable: true })
  longitude?: string | null;

  // ------------------------------------------

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