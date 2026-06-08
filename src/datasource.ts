import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { User } from './models/User';
import { ChatMessage } from './models/ChatMessage';
import { Client } from './models/Client';
import { Installation } from './models/Installation';
import { MYSQL } from './config';
import { SmartoltZone } from './models/SmartoltZone';
import { SmartoltOdb } from './models/SmartoltOdb';
import { ChatSession } from './models/ChatSession';
import { SmartoltOnuSnapshot } from './models/SmartoltOnuSnapshot';
import { SmartoltOnuDetail } from './models/SmartoltOnuDetail';
import { WizardSession } from './models/WizardSession';

export const AppDataSource = new DataSource({
  type: 'mysql',
  host: MYSQL.host,
  port: MYSQL.port,
  username: MYSQL.user,
  password: MYSQL.password,
  database: MYSQL.database,
  entities: [User, ChatMessage, Client, Installation, SmartoltZone, SmartoltOdb, ChatSession, SmartoltOnuSnapshot, SmartoltOnuDetail, WizardSession],
  synchronize: true
});
