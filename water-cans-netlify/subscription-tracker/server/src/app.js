import express from 'express';
import cors from 'cors';

const app = express();

app.use(cors({ origin: process.env.CLIENT_URL })); // let our React app call us
app.use(express.json()); // read JSON request bodies

// Health check: open /api/health to see if the server is alive
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Unknown route -> 404
app.use((req, res) => res.status(404).json({ message: 'Not found' }));

// Error handler (Express 5 catches async errors for us)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ message: err.message || 'Server error' });
});

export default app;
