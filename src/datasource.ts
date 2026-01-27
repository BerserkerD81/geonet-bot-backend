import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { User } from './models/User';
import { ChatMessage } from './models/ChatMessage';
import { MYSQL } from './config';
<<<<<<< HEAD
import { SmartoltZone } from './models/SmartoltZone';
import { SmartoltOdb } from './models/SmartoltOdb';
import { SmartoltOlt } from './models/SmartoltOlt';
import { SmartoltVlan } from './models/SmartoltVlan';
=======
>>>>>>> parent of d0c9887 (feat: add Wisphub client and installation services with full sync capabilities)

export const AppDataSource = new DataSource({
  type: 'mysql',
  host: MYSQL.host,
  port: MYSQL.port,
  username: MYSQL.user,
  password: MYSQL.password,
  database: MYSQL.database,
<<<<<<< HEAD
  entities: [User, ChatMessage, Client, Installation, SmartoltZone, SmartoltOdb, SmartoltOlt, SmartoltVlan],
=======
  entities: [User, ChatMessage],
>>>>>>> parent of d0c9887 (feat: add Wisphub client and installation services with full sync capabilities)
  synchronize: true
});
