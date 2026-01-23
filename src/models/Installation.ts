import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index, BeforeInsert, BeforeUpdate } from 'typeorm';
import { parseRaw, asDate, asString, stripHtml } from '../services/rawParser';
import { scheduleSyncRawToColumns } from '../services/rawColumnSyncScheduler';

@Entity()
export class Installation {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index({ unique: true })
  @Column({ type: 'int', nullable: true })
  id_servicio?: number | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  tipo?: string | null; // instalacion / preinstalacion

  @Column({ type: 'varchar', length: 64, nullable: true })
  estado_instalacion?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  usuario?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  nombre?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  apellidos?: string | null;

  @Column({ type: 'simple-json', nullable: true })
  raw?: any;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  razon_social?: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  tipo_persona?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  cedula?: string | null;

  @Column({ type: 'text', nullable: true })
  direccion?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  localidad?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  ciudad?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  telefono?: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  rfc?: string | null;

  @Column({ type: 'text', nullable: true })
  informacion_adicional?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  firewall?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  servicio?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  estado?: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  modelo_router_wifi?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip_router_wifi?: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  mac_router_wifi?: string | null;

  @Column({ type: 'text', nullable: true })
  comentarios?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  coordenadas?: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  sn_onu?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  fecha_instalacion?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ultimo_cambio?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  plan_internet?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  zona?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  router?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  sectorial?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  tecnico?: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  @BeforeInsert()
  @BeforeUpdate()
  normalizeFromRaw() {
    if (!this.raw) return;
    const parsed = parseRaw(this.raw);
    try {
      if (!this.informacion_adicional) this.informacion_adicional = stripHtml(asString(parsed, 'informacion_adicional')) ?? this.informacion_adicional;
      if (!this.comentarios) this.comentarios = stripHtml(asString(parsed, 'comentarios')) ?? this.comentarios;
      const fi = asDate(parsed, 'fecha_instalacion');
      if (fi) this.fecha_instalacion = fi instanceof Date ? fi.toISOString() : String(fi);
      const uc = asDate(parsed, 'ultimo_cambio');
      if (uc) this.ultimo_cambio = uc instanceof Date ? uc.toISOString() : String(uc);
    } catch (e) {
      // ignore
    }
    try { scheduleSyncRawToColumns(); } catch {}
  }
}
