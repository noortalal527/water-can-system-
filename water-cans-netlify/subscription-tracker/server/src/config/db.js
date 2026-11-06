import mongoose from 'mongoose';

// Connect to MongoDB. If it fails, stop the app (no point running without a DB).
export async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('MongoDB connected');
  } catch (err) {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  }
}
