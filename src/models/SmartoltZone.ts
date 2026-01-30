import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { SmartoltOdb } from './SmartoltOdb';

@Entity('smartolt_zone')
export class SmartoltZone {
  @PrimaryGeneratedColumn()
  id!: number;

  // Este guardará el ID "46", "48", etc. del JSON
  @Column({ type: 'varchar', length: 255, unique: true, nullable: true })
  externalId?: string | null;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({ type: 'datetime' })
  collectedAt!: Date;

  @OneToMany(() => SmartoltOdb, (odb) => odb.zone)
  odbs!: SmartoltOdb[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}