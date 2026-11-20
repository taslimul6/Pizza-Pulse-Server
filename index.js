import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// MongoDB connect
const client = new MongoClient(process.env.MONGODB_URI);


export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

connectToMongoDB();
const db = client.db("pizzaPulse");
const collection = db.collection("pizza");
const orders = db.collection("orders");



//apis

app.get("/", async (req, res) => {
  const pizzas = await collection.find().toArray();
  res.json(pizzas);
});


// All unique categories from the pizza collection
app.get("/category", async (req, res) => {
  const categories = await collection.distinct("category");
  res.json(categories);
});

// 6 featured pizzas (highest rated first)
app.get("/featured", async (req, res) => {
  const pizzas = await collection.find().sort({ rating: -1 }).limit(6).toArray();
  res.json(pizzas);
});

// Save a new order: { name, email, orderDetails }
app.post("/orders", async (req, res) => {
  const { name, email, orderDetails } = req.body;

  // name and email are required
  if (!name || !email) {
    return res.status(400).json({ error: "name and email are required" });
  }

  const result = await orders.insertOne({
    name,
    email,
    orderDetails,
    createdAt: new Date(),
  });
  res.status(201).json({ orderId: result.insertedId });
});

// All orders, newest first
app.get("/orders", async (req, res) => {
  const list = await orders.find().sort({ createdAt: -1 }).toArray();
  res.json(list);
});

app.listen(PORT, () => {
  console.log("server is running at " + PORT);
});
