import mongoose from 'mongoose';
import { env } from './env.js';

export async function connectDB() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.mongoUri);
  console.log('MongoDB connected');
  // Batch names used to be unique across the whole system; now they only need to be unique inside a course.
  try {
    await mongoose.connection.collection('batches').dropIndex('name_1');
    console.log('Dropped old global batch-name index');
  } catch {
    /* index already gone, or collection does not exist yet */
  }
}
