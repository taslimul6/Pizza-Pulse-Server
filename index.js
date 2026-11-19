import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();




const app = express();
const PORT = process.env.PORT || 5000;

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  })
);
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ message: "Pizza Pulse API is running" });
});





app.listen(PORT, (err) => {
  // Express 5 passes listen errors (e.g. port in use / reserved) to this callback.
  if (err) {
    console.error(`Failed to start server on port ${PORT}:`, err.message);
    process.exit(1);
  }
  console.log(`Pizza Pulse server listening on http://localhost:${PORT}`);
});
