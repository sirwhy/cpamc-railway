/**
 * CPAMC MongoDB Connection v3
 * Persistent connection dengan auto-reconnect
 * Supports MongoDB Atlas (free tier dari GitHub Student)
 */

const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
let isConnected = false;

async function connect() {
  if (isConnected) return;
  if (!MONGO_URI) {
    console.warn('⚠️  MONGODB_URI tidak diset — fallback ke penyimpanan file lokal.');
    return;
  }

  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    isConnected = true;
    console.log('✅ MongoDB terhubung');
  } catch (e) {
    console.error('❌ MongoDB gagal terhubung:', e.message);
    console.warn('   → Fallback ke penyimpanan file lokal.');
  }

  mongoose.connection.on('disconnected', () => {
    isConnected = false;
    console.warn('⚠️  MongoDB terputus — mencoba reconnect...');
  });

  mongoose.connection.on('reconnected', () => {
    isConnected = true;
    console.log('✅ MongoDB terhubung kembali');
  });
}

function isReady() {
  return isConnected && mongoose.connection.readyState === 1;
}

module.exports = { connect, isReady };
