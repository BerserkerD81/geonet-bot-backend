import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, OneToMany, Index } from 'typeorm';
import { ChatMessage } from './ChatMessage'; // Asegúrate de importar tu entidad actual

@Entity()
export class ChatSession {
  @PrimaryGeneratedColumn('increment')
  id!: number;

  @Index()
  @Column('int')
  userId!: number;

  @Column('varchar', { length: 255, default: 'Conversación Nueva' })
  title!: string;

  @Column('simple-json', { nullable: true })
  context?: Record<string, any> | null;

  @CreateDateColumn()
  createdAt!: Date;

  @Column('datetime', { nullable: true })
  deletedByUserAt?: Date | null;

  // Relación inversa: Una sesión tiene muchos mensajes
  @OneToMany(() => ChatMessage, (message) => message.session)
  messages!: ChatMessage[];
}