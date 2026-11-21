import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ObjectId } from "mongodb";
import Stripe from "stripe";
import { createAuth } from "./src/middleware/auth.js";

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
// Vendor subscription payments. Keys: vendorId (ref: users), plan, amount, currency,
// stripeSessionId, stripeSubscriptionId, status, createdAt (+ cardLast4, periods, payment intent)
const payments = db.collection("transactions");

// JWT checks for the protected routes (see src/middleware/auth.js)
//   authenticate         : the request must carry a valid, unexpired token
//   requireRole("vendor"): the user must also have that role
// After authenticate, req.user is the logged-in user (from the database).
const { authenticate, requireRole } = createAuth(users);

// Connect, then add indexes so the lists load fast
connectToMongoDB().then(async () => {
  try {
    await orders.createIndex({ customerId: 1, createdAt: -1 });
    await orders.createIndex({ vendorId: 1, createdAt: -1 });
    await collection.createIndex({ vendorId: 1, createdAt: -1 });
    // one Stripe payment can give Premium only once
    await payments.createIndex({ stripeSessionId: 1 }, { unique: true, sparse: true });
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

// ---- Public (no token needed) ----

// Customers only see approved items
const publicItems = { status: "approved" };

// Approved items, with:
//   vendorPremium : true when the vendor's premium plan is active
//   vendorName    : the vendor's restaurant name (or name), null for old seed items
// Options:
//   match    : extra filters (search, category, location, price)
//   sort     : sort order (default: as stored)
//   featured : premium vendors first, then the best rated, 6 items
async function approvedItems({ match = {}, sort = null, featured = false } = {}) {
  const pipeline = [
    { $match: { ...publicItems, ...match } },
    { $lookup: { from: "user", localField: "vendorId", foreignField: "_id", as: "vendorUser" } },
    {
      $addFields: {
        vendorPremium: {
          $and: [
            { $eq: [{ $first: "$vendorUser.subscriptionPlan" }, "premium"] },
            { $gt: [{ $first: "$vendorUser.subscriptionExpiresAt" }, new Date()] },
          ],
        },
        vendorName: {
          $ifNull: [{ $first: "$vendorUser.businessName" }, { $first: "$vendorUser.name" }],
        },
      },
    },
    { $project: { vendorUser: 0 } },
  ];
  if (featured) pipeline.push({ $sort: { vendorPremium: -1, rating: -1 } }, { $limit: 6 });
  else if (sort) pipeline.push({ $sort: sort });
  return collection.aggregate(pipeline).toArray();
}

app.get("/", async (req, res) => {
  res.json(await approvedItems());
});

// Browse Menu with search, filters and sorting (all done by MongoDB)
// GET /menu?search=pepperoni&category=classic-pizzas&location=Downtown
//          &minPrice=5&maxPrice=20&sort=price_asc
//   search   : part of the item name or description (case-insensitive)
//   category : exact category slug
//   location : exact location (area / city)
//   minPrice / maxPrice : price range
//   sort     : newest (default) | price_asc | price_desc | rating
// Answer: { items, total, categories, locations }
const sortOptions = {
  newest: { createdAt: -1, _id: -1 },
  price_asc: { price: 1, _id: 1 },
  price_desc: { price: -1, _id: 1 },
  rating: { rating: -1, _id: 1 },
};

// "Pepperoni (Large)" -> "Pepperoni \(Large\)" so user text is never treated as a regex
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

app.get("/menu", async (req, res) => {
  const search = String(req.query.search ?? "").trim();
  const category = String(req.query.category ?? "").trim();
  const location = String(req.query.location ?? "").trim();
  const sort = String(req.query.sort ?? "newest");
  const minPrice = req.query.minPrice === undefined || req.query.minPrice === "" ? null : Number(req.query.minPrice);
  const maxPrice = req.query.maxPrice === undefined || req.query.maxPrice === "" ? null : Number(req.query.maxPrice);

  // Check the query values
  if (search.length > 60 || location.length > 60 || category.length > 60) {
    return res.status(400).json({ error: "Search, category and location must be 60 characters or less" });
  }
  if (!sortOptions[sort]) {
    return res.status(400).json({ error: `sort must be one of: ${Object.keys(sortOptions).join(", ")}` });
  }
  if ((minPrice !== null && !Number.isFinite(minPrice)) || (maxPrice !== null && !Number.isFinite(maxPrice))) {
    return res.status(400).json({ error: "minPrice and maxPrice must be numbers" });
  }

  // Build the MongoDB filter
  const match = {};
  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    match.$or = [{ itemName: pattern }, { description: pattern }];
  }
  if (category) match.category = category;
  if (location) match.location = location;
  if (minPrice !== null || maxPrice !== null) {
    match.price = {};
    if (minPrice !== null) match.price.$gte = minPrice;
    if (maxPrice !== null) match.price.$lte = maxPrice;
  }

  const [items, categories, locations] = await Promise.all([
    approvedItems({ match, sort: sortOptions[sort] }),
    collection.distinct("category", publicItems),
    collection.distinct("location", publicItems),
  ]);

  res.json({
    items,
    total: items.length,
    categories: categories.sort(),
    locations: locations.filter(Boolean).sort(),
  });
});


// All unique categories of the approved items
app.get("/category", async (req, res) => {
  const categories = await collection.distinct("category", publicItems);
  res.json(categories);
});

// 6 featured items: premium vendors first (featured placement), then highest rated
app.get("/featured", async (req, res) => {
  res.json(await approvedItems({ featured: true }));
});


// ---- Orders (token needed) ----

// Save a new order
// POST /orders   body: { orderDetails: { itemId, ... } }
// The customer comes from the token, the vendor from the ordered item.
app.post("/orders", authenticate, async (req, res) => {
  const { orderDetails } = req.body;

  if (!isId(orderDetails?.itemId)) {
    return res.status(400).json({ error: "orderDetails.itemId is required" });
  }

  // Find the ordered item (only approved items can be ordered)
  const item = await collection.findOne({ _id: new ObjectId(orderDetails.itemId), ...publicItems });
  if (!item) {
    return res.status(404).json({ error: "Item not found" });
  }

  // A vendor cannot order their own item
  if (item.vendorId?.equals(req.user._id)) {
    return res.status(403).json({ error: "You cannot order your own item.", code: "OWN_ITEM" });
  }

  // No duplicate active orders: the same customer cannot have two pending or
  // accepted orders for the same item and the same delivery date
  const duplicate = await orders.findOne({
    customerId: req.user._id,
    "orderDetails.itemId": item._id,
    "orderDetails.deliveryDate": orderDetails.deliveryDate,
    "orderDetails.status": { $in: ["pending", "accepted"] },
  });
  if (duplicate) {
    return res.status(409).json({
      error: "You already have an active order for this item on this delivery date.",
      code: "DUPLICATE_ORDER",
    });
  }

  const vendorUser = item.vendorId ? await users.findOne({ _id: item.vendorId }) : null;

  const result = await orders.insertOne({
    customerId: req.user._id,
    vendorId: item.vendorId ?? null,
    name: req.user.name,
    email: req.user.email,
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

// All orders, newest first (admin only)
app.get("/orders", authenticate, requireRole("admin"), async (req, res) => {
  const list = await orders.find().sort({ createdAt: -1 }).toArray();
  res.json(list);
});

// Orders of the logged-in customer, newest first
app.get("/orders/customer", authenticate, async (req, res) => {
  const list = await orders.find({ customerId: req.user._id }).sort({ createdAt: -1 }).toArray();
  res.json(list);
});

// Orders of the logged-in vendor, newest first
app.get("/orders/vendor", authenticate, requireRole("vendor"), async (req, res) => {
  const list = await orders.find({ vendorId: req.user._id }).sort({ createdAt: -1 }).toArray();
  res.json(list);
});

// Vendor moves an order forward
// PATCH /orders/:id/status   body: { action }
//   accept   : pending  -> accepted
//   reject   : pending  -> rejected
//   complete : accepted -> completed
const orderSteps = {
  accept: { from: "pending", to: "accepted" },
  reject: { from: "pending", to: "rejected" },
  complete: { from: "accepted", to: "completed" },
};

app.patch("/orders/:id/status", authenticate, requireRole("vendor"), async (req, res) => {
  const { id } = req.params;
  const step = orderSteps[req.body.action];

  if (!isId(id) || !step) {
    return res.status(400).json({ error: "A valid order id and action are required" });
  }

  // Only this vendor's order, and only in the right status (so a second click changes nothing)
  const result = await orders.updateOne(
    { _id: new ObjectId(id), vendorId: req.user._id, "orderDetails.status": step.from },
    { $set: { "orderDetails.status": step.to, updatedAt: new Date() } }
  );

  if (result.matchedCount === 0) {
    return res.status(404).json({ error: `No order found that can be moved with "${req.body.action}"` });
  }
  res.json({ message: "Order updated", status: step.to });
});

// Customer cancels a pending order (it stays in the collection as "cancelled")
// PATCH /orders/:id/cancel
app.patch("/orders/:id/cancel", authenticate, async (req, res) => {
  const { id } = req.params;

  if (!isId(id)) {
    return res.status(400).json({ error: "Invalid order id" });
  }

  // Only the customer's own order, and only while it is pending
  const result = await orders.updateOne(
    { _id: new ObjectId(id), customerId: req.user._id, "orderDetails.status": "pending" },
    { $set: { "orderDetails.status": "cancelled", updatedAt: new Date() } }
  );

  if (result.matchedCount === 0) {
    return res.status(404).json({ error: "Pending order not found" });
  }
  res.json({ message: "Order cancelled", status: "cancelled" });
});


// ---- Vendor menu (vendor token needed) ----

// Vendor adds a menu item:
// { itemName, category, description, price, location, image }
// It is saved with status "pending" until an admin approves it.
app.post("/menu", authenticate, requireRole("vendor"), async (req, res) => {
  const { itemName, category, description, price, location, image } = req.body;

  const cleanPrice = Number(price);
  if (
    !itemName || !category || !description || !location || !image ||
    !Number.isFinite(cleanPrice) || cleanPrice <= 0
  ) {
    return res.status(400).json({ error: "All fields are required" });
  }

  // Free plan: at most 3 menu items in total (any status)
  if (!(await hasRoom(req.user))) {
    return res.status(403).json({
      error: `The Free plan allows ${FREE_LIMIT} menu items. Upgrade to Premium to add more.`,
      code: "FREE_ITEM_LIMIT",
    });
  }

  const result = await collection.insertOne({
    vendorId: req.user._id,
    itemName,
    slug: toSlug(itemName),
    description,
    category,
    emoji: "🍕",
    shop: toSlug(req.user.businessName || req.user.name || "vendor"),
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

// All items of the logged-in vendor (any status)
app.get("/menu/mine", authenticate, requireRole("vendor"), async (req, res) => {
  const items = await collection
    .find({ vendorId: req.user._id })
    .sort({ createdAt: -1 })
    .toArray();
  res.json(items);
});

// Vendor switches an item on (approved) or off (inactive)
// PATCH /menu/:id   body: { active: true | false }
// Pending and rejected items cannot be switched.
app.patch("/menu/:id", authenticate, requireRole("vendor"), async (req, res) => {
  const { id } = req.params;
  const { active } = req.body;

  if (!isId(id) || typeof active !== "boolean") {
    return res.status(400).json({ error: "id and active are required" });
  }

  // Free plan: at most 3 active items
  if (active && !(await hasRoom(req.user, { status: "approved" }))) {
    return res.status(409).json({
      error: `The Free plan allows ${FREE_LIMIT} active items. Switch one off or upgrade to Premium.`,
    });
  }

  const result = await collection.updateOne(
    { _id: new ObjectId(id), vendorId: req.user._id, status: active ? "inactive" : "approved" },
    { $set: { status: active ? "approved" : "inactive" } }
  );

  if (result.matchedCount === 0) {
    return res.status(404).json({ error: "Item not found or it cannot be switched" });
  }
  res.json({ message: "Item updated", status: active ? "approved" : "inactive" });
});

// Vendor edits an item. It goes back to "pending" so the admin can approve it again.
// PUT /menu/:id   body: { itemName, category, description, price, location, image }
// image is optional (the old images stay if it is not sent)
app.put("/menu/:id", authenticate, requireRole("vendor"), async (req, res) => {
  const { id } = req.params;
  const { itemName, category, description, price, location, image } = req.body;

  const cleanPrice = Number(price);
  if (
    !isId(id) || !itemName || !category || !description || !location ||
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
    { _id: new ObjectId(id), vendorId: req.user._id },
    { $set: changes }
  );

  if (result.matchedCount === 0) {
    return res.status(404).json({ error: "Item not found" });
  }
  res.json({ message: "Item updated", status: "pending" });
});

// Vendor deletes an item: DELETE /menu/:id
app.delete("/menu/:id", authenticate, requireRole("vendor"), async (req, res) => {
  const { id } = req.params;

  if (!isId(id)) {
    return res.status(400).json({ error: "Invalid item id" });
  }

  // Only the owner can delete
  const result = await collection.deleteOne({
    _id: new ObjectId(id),
    vendorId: req.user._id,
  });

  if (result.deletedCount === 0) {
    return res.status(404).json({ error: "Item not found" });
  }
  res.json({ message: "Item deleted" });
});


// ---- Admin (admin token needed) ----

// All items with every status, with the vendor's name and email
// GET /admin/menu
app.get("/admin/menu", authenticate, requireRole("admin"), async (req, res) => {
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

app.patch("/admin/menu/:id/status", authenticate, requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!isId(id)) {
    return res.status(400).json({ error: "Invalid item id" });
  }
  // Any other status would make the item visible to customers by mistake
  if (!itemStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${itemStatuses.join(", ")}` });
  }

  // Approving counts as one more active item for the vendor (Free plan: max 3)
  if (status === "approved") {
    const item = await collection.findOne({ _id: new ObjectId(id) });
    if (item && item.status !== "approved" && item.vendorId) {
      const vendor = await users.findOne({ _id: item.vendorId });
      if (!(await hasRoom(vendor, { status: "approved" }))) {
        return res.status(409).json({
          error: `This vendor is on the Free plan and already has ${FREE_LIMIT} active items.`,
        });
      }
    }
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
app.delete("/admin/menu/:id", authenticate, requireRole("admin"), async (req, res) => {
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
app.get("/users", authenticate, requireRole("admin"), async (req, res) => {
  const list = await users
    .find({}, { projection: { name: 1, email: 1, image: 1, role: 1, isBlocked: 1, businessName: 1, subscriptionPlan: 1, subscriptionExpiresAt: 1, emailVerified: 1, createdAt: 1 } })
    .sort({ createdAt: -1 })
    .toArray();
  res.json(list);
});

// Block or unblock a user (admins are never blocked)
// PATCH /users/:id/block   body: { isBlocked: true | false }
app.patch("/users/:id/block", authenticate, requireRole("admin"), async (req, res) => {
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
app.get("/stats", authenticate, requireRole("admin"), async (req, res) => {
  res.json({
    users: await users.countDocuments(),
    vendors: await users.countDocuments({ role: "vendor" }),
    customers: await users.countDocuments({ role: "customer" }),
    menuItems: await collection.countDocuments(),
    pendingItems: await collection.countDocuments({ status: "pending" }),
    transactions: (await orders.countDocuments()) + (await payments.countDocuments()),
  });
});


// ---- Vendor subscription (vendor token needed) ----

// Plans:
//   free    : max 3 menu items (and so max 3 active items)
//   premium : unlimited items, "Premium vendor" badge, shown first in Featured
// Premium lasts PREMIUM_DAYS after each payment and does not renew by itself.
const FREE_LIMIT = 3;
const PREMIUM_PRICE = 19.99;
const PREMIUM_DAYS = 30;

// True when the user has a premium plan that has not ended yet
const isPremium = (user) =>
  user?.subscriptionPlan === "premium" &&
  !!user.subscriptionExpiresAt &&
  new Date(user.subscriptionExpiresAt) > new Date();

// Can this vendor have one more item? Premium: always. Free: fewer than 3.
//   hasRoom(vendor)                         counts all items    (POST /menu)
//   hasRoom(vendor, { status: "approved" }) counts active items (switch on, approve)
async function hasRoom(vendor, filter = {}) {
  if (!vendor || isPremium(vendor)) return true;
  const count = await collection.countDocuments({ vendorId: vendor._id, ...filter });
  return count < FREE_LIMIT;
}

// The vendor's plan: GET /subscription
app.get("/subscription", authenticate, requireRole("vendor"), async (req, res) => {
  const premium = isPremium(req.user);
  res.json({
    plan: premium ? "premium" : "free",
    expiresAt: premium ? req.user.subscriptionExpiresAt : null,
    totalItems: await collection.countDocuments({ vendorId: req.user._id }),
    itemLimit: premium ? null : FREE_LIMIT,
    activeItems: await collection.countDocuments({ vendorId: req.user._id, status: "approved" }),
    activeLimit: premium ? null : FREE_LIMIT,
    price: PREMIUM_PRICE,
    periodDays: PREMIUM_DAYS,
  });
});

// ---- Stripe (vendor subscriptions only) ----
// Flow:
// 1. POST /subscription/checkout -> we create a Stripe Checkout page and send its url.
//    The vendor pays on Stripe's own page (we never see the card).
// 2. Stripe sends the vendor back to /vendor/subscription?session_id=...
// 3. POST /subscription/confirm { sessionId } -> we ask Stripe if that session is
//    paid and belongs to this vendor, then give 30 days of Premium.
//    The same session works only once (unique index on stripeSessionId).
// Env: STRIPE_SECRET_KEY (sk_test_... in test mode), AUTH_URL (the Next.js app, for the return links)
let stripeClient;
const stripe = () => (stripeClient ??= new Stripe(process.env.STRIPE_SECRET_KEY));

// Create the Stripe Checkout page: POST /subscription/checkout
app.post("/subscription/checkout", authenticate, requireRole("vendor"), async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: "Stripe is not set up on the server" });
  }

  const appUrl = new URL(process.env.AUTH_URL).origin;

  const session = await stripe().checkout.sessions.create({
    mode: "payment", // one payment = 30 days, it does not renew by itself
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: Math.round(PREMIUM_PRICE * 100), // in cents
          product_data: { name: `PizzaHub Premium (${PREMIUM_DAYS} days)` },
        },
      },
    ],
    customer_email: req.user.email,
    metadata: { vendorId: req.user._id.toHexString() }, // checked again in /confirm
    success_url: `${appUrl}/vendor/subscription?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/vendor/subscription?cancelled=1`,
  });

  res.status(201).json({ url: session.url });
});

// Check a finished Stripe Checkout and give Premium: POST /subscription/confirm { sessionId }
// Paying again while premium adds 30 more days on top of the current end date.
app.post("/subscription/confirm", authenticate, requireRole("vendor"), async (req, res) => {
  const { sessionId } = req.body;
  if (typeof sessionId !== "string" || !sessionId.startsWith("cs_")) {
    return res.status(400).json({ error: "Invalid sessionId" });
  }

  // Ask Stripe about the payment (never trust the browser)
  let session;
  try {
    session = await stripe().checkout.sessions.retrieve(sessionId, {
      expand: ["payment_intent.latest_charge"],
    });
  } catch {
    return res.status(404).json({ error: "Stripe session not found" });
  }

  // It must be this vendor's payment, and it must be paid
  if (session.metadata?.vendorId !== req.user._id.toHexString()) {
    return res.status(403).json({ error: "This payment belongs to another vendor" });
  }
  if (session.payment_status !== "paid") {
    return res.status(402).json({ error: "The payment is not completed" });
  }

  // Premium runs for 30 days (added to the current end date if still premium)
  const now = new Date();
  const start = isPremium(req.user) ? new Date(req.user.subscriptionExpiresAt) : now;
  const end = new Date(start.getTime() + PREMIUM_DAYS * 24 * 60 * 60 * 1000);

  // Save the payment. The unique index on stripeSessionId stops the same
  // payment from being used twice (page refresh, two requests at once).
  try {
    await payments.insertOne({
      vendorId: req.user._id,
      plan: "premium",
      amount: session.amount_total / 100,
      currency: session.currency,
      cardLast4: session.payment_intent?.latest_charge?.payment_method_details?.card?.last4 ?? null,
      status: "paid",
      stripeSessionId: session.id,
      // One-time Checkout payments (mode "payment") have no Stripe subscription, so this is null
      stripeSubscriptionId:
        typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null,
      stripePaymentIntentId: session.payment_intent?.id ?? null,
      periodStart: start,
      periodEnd: end,
      createdAt: now,
    });
  } catch (err) {
    if (err?.code === 11000) {
      return res.json({ plan: "premium", expiresAt: req.user.subscriptionExpiresAt, alreadyApplied: true });
    }
    throw err;
  }

  await users.updateOne(
    { _id: req.user._id },
    { $set: { subscriptionPlan: "premium", subscriptionExpiresAt: end, updatedAt: now } }
  );
  res.status(201).json({ plan: "premium", expiresAt: end });
});


// ---- Admin transactions (admin token needed) ----

// Orders and vendor subscription payments together. READ ONLY: no route changes one.
// The payment status of an order is worked out from the order status.
const paymentStatusOf = {
  pending: "pending",
  accepted: "paid",
  completed: "paid",
  rejected: "refunded",
  cancelled: "refunded",
};

// GET /admin/transactions
app.get("/admin/transactions", authenticate, requireRole("admin"), async (req, res) => {
  // Brings the vendor's user document along with each order / payment
  const vendorLookup = {
    $lookup: { from: "user", localField: "vendorId", foreignField: "_id", as: "vendorUser" },
  };
  const orderList = await orders.aggregate([vendorLookup]).toArray();
  const paymentList = await payments.aggregate([vendorLookup]).toArray();

  // Customer orders (the customer pays the vendor)
  const orderRows = orderList.map((order) => {
    const d = order.orderDetails || {};
    const vendor = order.vendorUser[0];
    return {
      _id: order._id,
      type: "order",
      plan: null,
      vendor: {
        name: vendor?.businessName || vendor?.name || order.vendor?.name || null,
        email: vendor?.email ?? null,
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

  // Subscription payments (the vendor pays PizzaHub)
  const subscriptionRows = paymentList.map((payment) => {
    const vendor = payment.vendorUser[0];
    return {
      _id: payment._id,
      type: "subscription",
      plan: payment.plan,
      vendor: { name: vendor?.businessName || vendor?.name || null, email: vendor?.email ?? null, shop: null },
      customer: null,
      itemName: `${titleCase(payment.plan)} plan (${PREMIUM_DAYS} days)`,
      amount: payment.amount,
      cardLast4: payment.cardLast4,
      orderStatus: null,
      paymentStatus: payment.status,
      createdAt: payment.createdAt,
    };
  });

  // Orders and subscriptions together, newest first
  const transactions = [...orderRows, ...subscriptionRows].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  res.json(transactions);
});

// Add new APIs above this line (keep app.listen last)

app.listen(PORT, () => {
  console.log("server is running at " + PORT);
});
