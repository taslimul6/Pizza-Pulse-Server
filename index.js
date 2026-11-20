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

const db = client.db("pizzaPulse");
const collection = db.collection("pizza");
// The "orders" collection (MongoDB creates it on the first order)
const orders = db.collection("orders");

// Connect, then add indexes so "my orders" and the vendor's orders load fast
connectToMongoDB().then(async () => {
  try {
    await orders.createIndex({ "customer.email": 1, createdAt: -1 });
    await orders.createIndex({ "vendor.email": 1, createdAt: -1 });
  } catch (err) {
    console.dir(err);
  }
});



//apis

// Customers only see published items. "pending" and "rejected" items are hidden.
// Older items without a status field are still shown.
const notPending = { status: { $nin: ["pending", "rejected"] } };

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

// "pizzahub-downtown" -> "Pizzahub Downtown"
function titleCase(slug) {
  return String(slug || "")
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// Save a new order: { name, email, customerId, orderDetails }
// orderDetails holds the item information and the order status.
// The vendor information is looked up from the ordered item in the pizza collection.
app.post("/orders", async (req, res) => {
  const { name, email, customerId, orderDetails } = req.body;

  // name, email and the item are required
  if (!name || !email) {
    return res.status(400).json({ error: "name and email are required" });
  }
  if (!orderDetails?.itemId) {
    return res.status(400).json({ error: "orderDetails.itemId is required" });
  }

  // Find the ordered item to get the vendor information
  const item = ObjectId.isValid(orderDetails.itemId) && orderDetails.itemId.length === 24
    ? await collection.findOne({ _id: new ObjectId(orderDetails.itemId) })
    : null;

  const vendor = {
    id: item?.vendor?.id ?? null,
    name: item?.vendor?.name ?? titleCase(item?.shop ?? orderDetails.shop),
    email: item?.vendor?.email ?? null,
    shop: item?.shop ?? orderDetails.shop ?? null,
    location: item?.location ?? null,
  };

  const result = await orders.insertOne({
    name,
    email,
    customer: { id: customerId ?? null, name, email },
    vendor,
    orderDetails: { ...orderDetails, status: "pending" },
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

// Orders of one vendor, newest first: GET /orders/vendor?email=vendor@email.com
app.get("/orders/vendor", async (req, res) => {
  const { email } = req.query;
  if (!email) {
    return res.status(400).json({ error: "email is required" });
  }
  const list = await orders
    .find({ "vendor.email": email })
    .sort({ createdAt: -1 })
    .toArray();
  res.json(list);
});

// Vendor moves an order forward: PATCH /orders/:id/status  { email, action }
//   accept   : pending    -> in process
//   reject   : pending    -> rejected
//   complete : in process -> completed
// Only the vendor who owns the order can do it, and each step works only once.
const orderSteps = {
  accept: { from: "pending", to: "in process" },
  reject: { from: "pending", to: "rejected" },
  complete: { from: "in process", to: "completed" },
};

app.patch("/orders/:id/status", async (req, res) => {
  const { id } = req.params;
  const { email, action } = req.body;
  const step = orderSteps[action];

  if (id.length !== 24 || !ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  if (!email || !step) {
    return res.status(400).json({ error: "email and a valid action are required" });
  }

  const owner = { _id: new ObjectId(id), "vendor.email": email };

  // The status is part of the filter, so a second click changes nothing
  const result = await orders.updateOne(
    { ...owner, "orderDetails.status": step.from },
    { $set: { "orderDetails.status": step.to, updatedAt: new Date() } }
  );
  if (result.matchedCount === 1) {
    return res.json({ message: "Order updated", status: step.to });
  }

  // Not changed: not the vendor's order, or it is not in the right status
  const order = await orders.findOne(owner);
  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }
  res.status(409).json({
    error: `Cannot ${action}: this order is ${order.orderDetails?.status}, it must be ${step.from}.`,
  });
});

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

// Get all items of one vendor (any status)
// GET /menu/mine?email=vendor@email.com
app.get("/menu/mine", async (req, res) => {
  const { email } = req.query;

  // Without an email the filter would match items that have no vendor
  if (!email) {
    return res.status(400).json({ error: "email is required" });
  }

  const items = await collection.find({ "vendor.email": email }).sort({ createdAt: -1 }).toArray();
  res.json(items);
});

// Vendor turns a published item on/off
// PATCH /menu/:id   body: { email, available }
app.patch("/menu/:id", async (req, res) => {
  const { email, available } = req.body;

  // Only the owner can change it, and only if it is published
  await collection.updateOne(
    { _id: new ObjectId(req.params.id), "vendor.email": email, status: "publish" },
    { $set: { available } }
  );
  res.json({ message: "Item updated" });
});

// Vendor edits an item. It goes back to "pending" so the admin can approve it again.
// PUT /menu/:id   body: { email, name, category, description, price, location, image }
// image is optional (the old image stays if it is not sent)
app.put("/menu/:id", async (req, res) => {
  const { email, name, category, description, price, location, image } = req.body;

  const changes = {
    name,
    category,
    description,
    location,
    price: Number(price),
    sizes: [{ label: "Regular", price: Number(price) }],
    status: "pending",
    updatedAt: new Date(),
  };
  if (image) changes.image = image;

  // Only the owner can edit
  await collection.updateOne(
    { _id: new ObjectId(req.params.id), "vendor.email": email },
    { $set: changes }
  );
  res.json({ message: "Item updated", status: "pending" });
});

// Vendor deletes an item
// DELETE /menu/:id?email=vendor@email.com
app.delete("/menu/:id", async (req, res) => {
  // Only the owner can delete
  await collection.deleteOne({ _id: new ObjectId(req.params.id), "vendor.email": req.query.email });
  res.json({ message: "Item deleted" });
});

// ---- Admin ----

// All items with every status (customers only see published ones)
// GET /admin/menu
app.get("/admin/menu", async (req, res) => {
  const items = await collection.find().sort({ createdAt: -1 }).toArray();
  res.json(items);
});

// Approve / reject an item
// PATCH /admin/menu/:id/status   body: { status }
//   publish  = approved, shown on the public menu
//   pending  = waiting for review, hidden
//   rejected = hidden
app.patch("/admin/menu/:id/status", async (req, res) => {
  const { status } = req.body;

  // Any other status would make the item visible to customers
  if (!["publish", "pending", "rejected"].includes(status)) {
    return res.status(400).json({ error: "status must be publish, pending or rejected" });
  }

  await collection.updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { status, reviewedAt: new Date() } }
  );
  res.json({ message: "Status updated", status });
});

// Admin deletes any item
// DELETE /admin/menu/:id
app.delete("/admin/menu/:id", async (req, res) => {
  await collection.deleteOne({ _id: new ObjectId(req.params.id) });
  res.json({ message: "Item deleted" });
});

// All registered users (Better Auth "user" collection, no passwords)
// GET /users
app.get("/users", async (req, res) => {
  const list = await db
    .collection("user")
    .find({}, { projection: { name: 1, email: 1, role: 1, blocked: 1, emailVerified: 1, image: 1, createdAt: 1 } })
    .sort({ createdAt: -1 })
    .toArray();
  res.json(list);
});

// Block or unblock a user (admins are never blocked)
// PATCH /users/:id/block   body: { blocked: true | false }
app.patch("/users/:id/block", async (req, res) => {
  const { blocked } = req.body;
  const userId = new ObjectId(req.params.id);

  await db
    .collection("user")
    .updateOne({ _id: userId, role: { $ne: "admin" } }, { $set: { blocked, updatedAt: new Date() } });

  // A blocked user is logged out at once
  if (blocked) {
    await db.collection("session").deleteMany({ userId });
  }
  res.json({ message: blocked ? "User blocked" : "User unblocked", blocked });
});

// Numbers for the admin dashboard
// GET /stats
app.get("/stats", async (req, res) => {
  const users = db.collection("user");

  res.json({
    users: await users.countDocuments(),
    vendors: await users.countDocuments({ role: "vendor" }),
    customers: await users.countDocuments({ role: "customer" }),
    menuItems: await collection.countDocuments(),
    pendingItems: await collection.countDocuments({ status: "pending" }),
    transactions: await orders.countDocuments(),
  });
});

// Add new APIs above this line (keep app.listen last)

app.listen(PORT, () => {
  console.log("server is running at " + PORT);
});
