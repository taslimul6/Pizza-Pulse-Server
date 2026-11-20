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
const collection = db.collection("menuItems");
const orders = db.collection("orders");
const users = db.collection("user"); // Better Auth users

// Connect, then add indexes so the lists load fast
connectToMongoDB().then(async () => {
  try {
    await orders.createIndex({ customerId: 1, createdAt: -1 });
    await orders.createIndex({ vendorId: 1, createdAt: -1 });
    await collection.createIndex({ vendorId: 1, createdAt: -1 });
  } catch (err) {
    console.dir(err);
  }
});

// ---- Keys used in the collections ----
// users      : name, email, image, role, isBlocked, businessName,
//              subscriptionPlan, subscriptionExpiresAt
// menuItems  : vendorId, itemName, category, description, price, location,
//              images, status, createdAt
//              status = pending | approved | rejected | inactive
// orders     : itemId, vendorId, customerId, deliveryDate, deliveryAddress,
//              message, status, createdAt
//              (itemId, deliveryDate, deliveryAddress, message and status are
//               inside the orderDetails object)
//              status = pending | accepted | rejected | cancelled | completed

const isId = (id) => typeof id === "string" && id.length === 24 && ObjectId.isValid(id);

// "pizzahub-downtown" -> "Pizzahub Downtown"
function titleCase(slug) {
  return String(slug || "")
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// "Classic Pepperoni" -> "classic-pepperoni"
const toSlug = (text) => String(text).toLowerCase().trim().replace(/\s+/g, "-");


//apis

// Customers only see approved items
const publicItems = { status: "approved" };

app.get("/", async (req, res) => {
  const items = await collection.find(publicItems).toArray();
  res.json(items);
});


// All unique categories of the approved items
app.get("/category", async (req, res) => {
  const categories = await collection.distinct("category", publicItems);
  res.json(categories);
});

// 6 featured items (highest rated first)
app.get("/featured", async (req, res) => {
  const items = await collection.find(publicItems).sort({ rating: -1 }).limit(6).toArray();
  res.json(items);
});


// ---- Orders ----

// Save a new order: { customerId, name, email, orderDetails }
// orderDetails holds the item information, delivery details and the status.
// vendorId is looked up from the ordered item.
app.post("/orders", async (req, res) => {
  const { customerId, name, email, orderDetails } = req.body;

  if (!name || !email || !isId(customerId)) {
    return res.status(400).json({ error: "customerId, name and email are required" });
  }
  if (!isId(orderDetails?.itemId)) {
    return res.status(400).json({ error: "orderDetails.itemId is required" });
  }

  // Find the ordered item to get the vendor
  const item = await collection.findOne({ _id: new ObjectId(orderDetails.itemId) });
  if (!item) {
    return res.status(404).json({ error: "Item not found" });
  }

  const vendorUser = item.vendorId ? await users.findOne({ _id: item.vendorId }) : null;

  const result = await orders.insertOne({
    customerId: new ObjectId(customerId),
    vendorId: item.vendorId ?? null,
    name,
    email,
    vendor: {
      name: vendorUser?.businessName || vendorUser?.name || titleCase(item.shop),
      shop: item.shop ?? null,
      location: item.location ?? null,
    },
    orderDetails: {
      ...orderDetails,
      itemId: item._id,
      status: "pending",
    },
    createdAt: new Date(),
  });
  res.status(201).json({ orderId: result.insertedId });
});

// All orders, newest first
app.get("/orders", async (req, res) => {
  const list = await orders.find().sort({ createdAt: -1 }).toArray();
  res.json(list);
});

// Orders of one customer, newest first: GET /orders/customer?customerId=...
app.get("/orders/customer", async (req, res) => {
  const { customerId } = req.query;
  if (!isId(customerId)) {
    return res.status(400).json({ error: "customerId is required" });
  }
  const list = await orders
    .find({ customerId: new ObjectId(customerId) })
    .sort({ createdAt: -1 })
    .toArray();
  res.json(list);
});

// Orders of one vendor, newest first: GET /orders/vendor?vendorId=...
app.get("/orders/vendor", async (req, res) => {
  const { vendorId } = req.query;
  if (!isId(vendorId)) {
    return res.status(400).json({ error: "vendorId is required" });
  }
  const list = await orders
    .find({ vendorId: new ObjectId(vendorId) })
    .sort({ createdAt: -1 })
    .toArray();
  res.json(list);
});

// Vendor moves an order forward: PATCH /orders/:id/status  { vendorId, action }
//   accept   : pending  -> accepted
//   reject   : pending  -> rejected
//   complete : accepted -> completed
// Only the vendor who owns the order can do it, and each step works only once.
const orderSteps = {
  accept: { from: "pending", to: "accepted" },
  reject: { from: "pending", to: "rejected" },
  complete: { from: "accepted", to: "completed" },
};

app.patch("/orders/:id/status", async (req, res) => {
  const { id } = req.params;
  const { vendorId, action } = req.body;
  const step = orderSteps[action];

  if (!isId(id)) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  if (!isId(vendorId) || !step) {
    return res.status(400).json({ error: "vendorId and a valid action are required" });
  }

  const owner = { _id: new ObjectId(id), vendorId: new ObjectId(vendorId) };

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

// Customer cancels a pending order: PATCH /orders/:id/cancel  { customerId }
// The order stays in the collection with the status "cancelled".
app.patch("/orders/:id/cancel", async (req, res) => {
  const { id } = req.params;
  const { customerId } = req.body;

  if (!isId(id) || !isId(customerId)) {
    return res.status(400).json({ error: "Invalid order id or customerId" });
  }

  // Only the customer's own order, and only while it is still pending
  const result = await orders.updateOne(
    { _id: new ObjectId(id), customerId: new ObjectId(customerId), "orderDetails.status": "pending" },
    { $set: { "orderDetails.status": "cancelled", updatedAt: new Date() } }
  );

  if (result.matchedCount === 0) {
    return res.status(404).json({ error: "Pending order not found" });
  }
  res.json({ message: "Order cancelled", status: "cancelled" });
});


// ---- Vendor menu ----

// Vendor adds a menu item:
// { vendorId, vendorName, itemName, category, description, price, location, image }
// It is saved with status "pending" until an admin approves it.
app.post("/menu", async (req, res) => {
  const { vendorId, vendorName, itemName, category, description, price, location, image } = req.body;

  const cleanPrice = Number(price);
  if (
    !isId(vendorId) || !itemName || !category || !description || !location || !image ||
    !Number.isFinite(cleanPrice) || cleanPrice <= 0
  ) {
    return res.status(400).json({ error: "All fields are required" });
  }

  const result = await collection.insertOne({
    vendorId: new ObjectId(vendorId),
    itemName,
    slug: toSlug(itemName),
    description,
    category,
    emoji: "🍕",
    shop: toSlug(vendorName || "vendor"),
    location,
    price: cleanPrice,
    sizes: [{ label: "Regular", price: cleanPrice }],
    crust: ["Classic"],
    toppings: [],
    isVeg: false,
    isSpicy: false,
    rating: 0,
    prepTimeMin: 20,
    calories: 0,
    images: [image],
    status: "pending",
    createdAt: new Date(),
  });
  res.status(201).json({ itemId: result.insertedId, status: "pending" });
});

// Get all items of one vendor (any status): GET /menu/mine?vendorId=...
app.get("/menu/mine", async (req, res) => {
  const { vendorId } = req.query;

  // Without a vendorId the filter would match items that have no vendor
  if (!isId(vendorId)) {
    return res.status(400).json({ error: "vendorId is required" });
  }

  const items = await collection
    .find({ vendorId: new ObjectId(vendorId) })
    .sort({ createdAt: -1 })
    .toArray();
  res.json(items);
});

// Vendor switches an item on (approved) or off (inactive)
// PATCH /menu/:id   body: { vendorId, active: true | false }
// Pending and rejected items cannot be switched.
app.patch("/menu/:id", async (req, res) => {
  const { id } = req.params;
  const { vendorId, active } = req.body;

  if (!isId(id) || !isId(vendorId) || typeof active !== "boolean") {
    return res.status(400).json({ error: "id, vendorId and active are required" });
  }

  const result = await collection.updateOne(
    { _id: new ObjectId(id), vendorId: new ObjectId(vendorId), status: active ? "inactive" : "approved" },
    { $set: { status: active ? "approved" : "inactive" } }
  );

  if (result.matchedCount === 0) {
    return res.status(404).json({ error: "Item not found or it cannot be switched" });
  }
  res.json({ message: "Item updated", status: active ? "approved" : "inactive" });
});

// Vendor edits an item. It goes back to "pending" so the admin can approve it again.
// PUT /menu/:id   body: { vendorId, itemName, category, description, price, location, image }
// image is optional (the old images stay if it is not sent)
app.put("/menu/:id", async (req, res) => {
  const { id } = req.params;
  const { vendorId, itemName, category, description, price, location, image } = req.body;

  const cleanPrice = Number(price);
  if (
    !isId(id) || !isId(vendorId) || !itemName || !category || !description || !location ||
    !Number.isFinite(cleanPrice) || cleanPrice <= 0
  ) {
    return res.status(400).json({ error: "All fields are required" });
  }

  const changes = {
    itemName,
    category,
    description,
    location,
    price: cleanPrice,
    sizes: [{ label: "Regular", price: cleanPrice }],
    status: "pending",
    updatedAt: new Date(),
  };
  if (image) changes.images = [image];

  // Only the owner can edit
  const result = await collection.updateOne(
    { _id: new ObjectId(id), vendorId: new ObjectId(vendorId) },
    { $set: changes }
  );

  if (result.matchedCount === 0) {
    return res.status(404).json({ error: "Item not found" });
  }
  res.json({ message: "Item updated", status: "pending" });
});

// Vendor deletes an item: DELETE /menu/:id?vendorId=...
app.delete("/menu/:id", async (req, res) => {
  const { id } = req.params;
  const { vendorId } = req.query;

  if (!isId(id) || !isId(vendorId)) {
    return res.status(400).json({ error: "id and vendorId are required" });
  }

  // Only the owner can delete
  const result = await collection.deleteOne({
    _id: new ObjectId(id),
    vendorId: new ObjectId(vendorId),
  });

  if (result.deletedCount === 0) {
    return res.status(404).json({ error: "Item not found" });
  }
  res.json({ message: "Item deleted" });
});


// ---- Admin ----

// All items with every status, with the vendor's name and email
// GET /admin/menu
app.get("/admin/menu", async (req, res) => {
  const items = await collection
    .aggregate([
      { $sort: { createdAt: -1 } },
      { $lookup: { from: "user", localField: "vendorId", foreignField: "_id", as: "vendorUser" } },
    ])
    .toArray();

  res.json(
    items.map(({ vendorUser, ...item }) => ({
      ...item,
      vendorName: vendorUser[0]?.businessName || vendorUser[0]?.name || titleCase(item.shop),
      vendorEmail: vendorUser[0]?.email ?? null,
    }))
  );
});

// Change the status of an item
// PATCH /admin/menu/:id/status   body: { status }
//   approved = shown on the public menu
//   pending  = waiting for review, hidden
//   rejected = hidden
//   inactive = switched off, hidden
const itemStatuses = ["pending", "approved", "rejected", "inactive"];

app.patch("/admin/menu/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!isId(id)) {
    return res.status(400).json({ error: "Invalid item id" });
  }
  // Any other status would make the item visible to customers by mistake
  if (!itemStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${itemStatuses.join(", ")}` });
  }

  const result = await collection.updateOne(
    { _id: new ObjectId(id) },
    { $set: { status, reviewedAt: new Date() } }
  );
  if (result.matchedCount === 0) {
    return res.status(404).json({ error: "Item not found" });
  }
  res.json({ message: "Status updated", status });
});

// Admin deletes any item
// DELETE /admin/menu/:id
app.delete("/admin/menu/:id", async (req, res) => {
  const { id } = req.params;
  if (!isId(id)) {
    return res.status(400).json({ error: "Invalid item id" });
  }

  const result = await collection.deleteOne({ _id: new ObjectId(id) });
  if (result.deletedCount === 0) {
    return res.status(404).json({ error: "Item not found" });
  }
  res.json({ message: "Item deleted" });
});

// All registered users (Better Auth "user" collection, no passwords)
// GET /users
app.get("/users", async (req, res) => {
  const list = await users
    .find({}, { projection: { name: 1, email: 1, image: 1, role: 1, isBlocked: 1, businessName: 1, subscriptionPlan: 1, subscriptionExpiresAt: 1, emailVerified: 1, createdAt: 1 } })
    .sort({ createdAt: -1 })
    .toArray();
  res.json(list);
});

// Block or unblock a user (admins are never blocked)
// PATCH /users/:id/block   body: { isBlocked: true | false }
app.patch("/users/:id/block", async (req, res) => {
  const { id } = req.params;
  const { isBlocked } = req.body;

  if (!isId(id) || typeof isBlocked !== "boolean") {
    return res.status(400).json({ error: "Invalid user id or isBlocked" });
  }
  const userId = new ObjectId(id);

  const result = await users.updateOne(
    { _id: userId, role: { $ne: "admin" } },
    { $set: { isBlocked, updatedAt: new Date() } }
  );
  if (result.matchedCount === 0) {
    return res.status(404).json({ error: "User not found, or an admin (admins cannot be blocked)" });
  }

  // A blocked user is logged out at once
  if (isBlocked) {
    await db.collection("session").deleteMany({ userId });
  }
  res.json({ message: isBlocked ? "User blocked" : "User unblocked", isBlocked });
});

// Numbers for the admin dashboard
// GET /stats
app.get("/stats", async (req, res) => {
  res.json({
    users: await users.countDocuments(),
    vendors: await users.countDocuments({ role: "vendor" }),
    customers: await users.countDocuments({ role: "customer" }),
    menuItems: await collection.countDocuments(),
    pendingItems: await collection.countDocuments({ status: "pending" }),
    transactions: await orders.countDocuments(),
  });
});

// Transactions for the admin. READ ONLY: there is no route that changes one.
// The payment status is worked out from the order status.
const paymentStatusOf = {
  pending: "pending",
  accepted: "paid",
  completed: "paid",
  rejected: "refunded",
  cancelled: "refunded",
};

app.get("/admin/transactions", async (req, res) => {
  const list = await orders
    .aggregate([
      { $sort: { createdAt: -1 } },
      { $lookup: { from: "user", localField: "vendorId", foreignField: "_id", as: "vendorUser" } },
    ])
    .toArray();

  const transactions = list.map((order) => {
    const d = order.orderDetails || {};
    const vendorUser = order.vendorUser[0];
    return {
      _id: order._id,
      vendor: {
        name: vendorUser?.businessName || vendorUser?.name || order.vendor?.name || null,
        email: vendorUser?.email ?? null,
        shop: order.vendor?.shop ?? null,
      },
      customer: { name: order.name, email: order.email },
      itemName: d.itemName,
      amount: d.total,
      cardLast4: d.cardLast4,
      orderStatus: d.status,
      paymentStatus: paymentStatusOf[d.status] || "pending",
      createdAt: order.createdAt,
    };
  });
  res.json(transactions);
});

// Add new APIs above this line (keep app.listen last)

app.listen(PORT, () => {
  console.log("server is running at " + PORT);
});
