import { MongoClient, type Db } from 'mongodb'
import { env } from '@/config/env.js'

let client: MongoClient | null = null
let db: Db | null = null

export async function connectMongo(): Promise<Db> {
  if (db) return db
  client = new MongoClient(env.MONGODB_URI)
  await client.connect()
  db = client.db(env.MONGODB_DB)
  return db
}

export function getDb(): Db {
  if (!db) throw new Error('mongo not connected — call connectMongo() first')
  return db
}

export async function closeMongo(): Promise<void> {
  await client?.close()
  client = null
  db = null
}
