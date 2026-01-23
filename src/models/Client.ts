import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Index, BeforeInsert, BeforeUpdate } from 'typeorm';
import { parseRaw, asDate, asString, stripHtml } from '../services/rawParser';
import { scheduleSyncRawToColumns } from '../services/rawColumnSyncScheduler';

@Entity()
export class Client {
  @PrimaryColumn({ type: 'int' })
  id_servicio!: number;

  @Index()
  @Column({ type: 'varchar', length: 255, nullable: true })
  usuario?: string | null;

  @Index()
  @Column({ type: 'varchar', length: 255, nullable: true })
  nombre?: string | null;

  @Index()
  @Column({ type: 'varchar', length: 255, nullable: true })
  apellidos?: string | null;

  @Index()
  @Column({ type: 'varchar', length: 255, nullable: true })
  email?: string | null;

  @Index()
  @Column({ type: 'varchar', length: 255, nullable: true })
  telefono?: string | null;

  @Index()
  @Column({ type: 'varchar', length: 255, nullable: true })
  cedula?: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  direccion?: string | null;

  @Index()
  @Column({ type: 'varchar', length: 255, nullable: true })
  ciudad?: string | null;

  @Index()
  @Column({ type: 'varchar', length: 255, nullable: true })
  localidad?: string | null;

  @Index()
  @Column({ type: 'varchar', length: 255, nullable: true })
  usuario_rb?: string | null;

  @Index()
  @Column({ type: 'varchar', length: 128, nullable: true })
  sn_onu?: string | null;

  @Index()
  @Column({ type: 'varchar', length: 128, nullable: true })
  mac_cpe?: string | null;

  @Index()
  @Column({ type: 'varchar', length: 64, nullable: true })
  estado?: string | null;

  @Column({ type: 'simple-json', nullable: true })
  raw?: any;

  @Index()
  @Column({ type: 'varchar', length: 255, nullable: true })
  email_cc?: string | null;

  @Index()
  @Column({ type: 'varchar', length: 255, nullable: true })
  razon_social?: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  tipo_persona?: string | null;

  @Index()
  @Column({ type: 'varchar', length: 128, nullable: true })
  rfc?: string | null;

  @Column({ type: 'text', nullable: true })
  informacion_adicional?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  firewall?: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  servicio?: string | null;

  @Index()
  @Column({ type: 'varchar', length: 64, nullable: true })
  ip?: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  modelo_router_wifi?: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  mac_router_wifi?: string | null;

  @Column({ type: 'text', nullable: true })
  comentarios?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  precio_plan?: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  estado_facturas?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  fecha_instalacion?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  fecha_cancelacion?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  fecha_corte?: string | null;

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
  
  @Column({ type: 'datetime', nullable: true })
  lastSyncedAt?: Date | null;

  @BeforeInsert()
  @BeforeUpdate()
  normalizeFromRaw() {
    if (!this.raw) return;
    const parsed = parseRaw(this.raw);
    try {
      if (!this.informacion_adicional) this.informacion_adicional = stripHtml(asString(parsed, 'informacion_adicional')) ?? this.informacion_adicional;
      if (!this.comentarios) this.comentarios = stripHtml(asString(parsed, 'comentarios')) ?? this.comentarios;
      // fechas: if raw has date-like values prefer them
      const fi = asDate(parsed, 'fecha_instalacion');
      if (fi) this.fecha_instalacion = fi.toISOString();
      const fc = asDate(parsed, 'fecha_cancelacion');
      if (fc) this.fecha_cancelacion = fc.toISOString();
      const fco = asDate(parsed, 'fecha_corte');
      if (fco) this.fecha_corte = fco.toISOString();
      const uc = asDate(parsed, 'ultimo_cambio');
      if (uc) this.ultimo_cambio = uc.toISOString();
    } catch (e) {
      // be lenient
    }
    // schedule background sync to add columns if needed
    try { scheduleSyncRawToColumns(); } catch {}
  }
}
