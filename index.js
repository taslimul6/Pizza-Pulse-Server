import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ObjectId } from "mongodb";

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

// Items with status "pending" are hidden. Older items have no status field,
// so they are still shown.
const notPending = { status: { $ne: "pending" } };

app.get("/", async (req, res) => {
  const pizzas = await collection.find(notPending).toArray();
  res.json(pizzas);
});


// All unique categories from the pizza collection
app.get("/category", async (req, res) => {
  const categories = await collection.distinct("category", notPending);
  res.json(categories);
});

// 6 featured pizzas (highest rated first)
app.get("/featured", async (req, res) => {
  const pizzas = await collection.find(notPending).sort({ rating: -1 }).limit(6).toArray();
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

//

// Cancel (delete) a pending order: DELETE /orders/:id?email=customer@email.com
app.delete("/orders/:id", async (req, res) => {
  const { id } = req.params;
  const { email } = req.query;

  if (id.length !== 24 || !ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  if (!email) {
    return res.status(400).json({ error: "email is required" });
  }

  // Delete only if it belongs to this email AND is still pending
  const result = await orders.deleteOne({
    _id: new ObjectId(id),
    email,
    "orderDetails.status": "pending",
  });

  if (result.deletedCount === 0) {
    return res.status(404).json({ error: "Pending order not found" });
  }
  res.json({ message: "Order cancelled" });
});

// Vendor adds a menu item: { name, category, description, price, location, image, vendor: { id, name, email } }
// It is saved with status "pending" until an admin approves it.
app.post("/menu", async (req, res) => {
  const { name, category, description, price, location, image, vendor } = req.body;

  const cleanPrice = Number(price);
  if (
    !name || !category || !description || !location || !image ||
    !vendor?.id || !vendor?.email ||
    !Number.isFinite(cleanPrice) || cleanPrice <= 0
  ) {
    return res.status(400).json({ error: "All fields are required" });
  }

  // "Classic Pepperoni" -> "classic-pepperoni"
  const toSlug = (text) => text.toLowerCase().trim().replace(/\s+/g, "-");

  const result = await collection.insertOne({
    name,
    slug: toSlug(name),
    description,
    category,
    emoji: "🍕",
    shop: toSlug(vendor.name || vendor.email),
    location,
    price: cleanPrice,
    sizes: [{ label: "Regular", price: cleanPrice }],
    crust: ["Classic"],
    toppings: [],
    isVeg: false,
    isSpicy: false,
    rating: 0,
    available: true,
    prepTimeMin: 20,
    calories: 0,
    image,
    status: "pending",
    vendor: { id: vendor.id, name: vendor.name, email: vendor.email },
    createdAt: new Date(),
  });
  res.status(201).json({ itemId: result.insertedId, status: "pending" });
});

// Add new APIs above this line (keep app.listen last)

app.listen(PORT, () => {
  console.log("server is running at " + PORT);
});
