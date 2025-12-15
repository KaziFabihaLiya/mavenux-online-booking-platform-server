const express = require("express");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const cors = require("cors");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// ============================================
// MIDDLEWARE
// ============================================
app.use(
  cors({
    origin: ["http://localhost:5173", "http://localhost:3000"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

// ============================================
// MONGODB CONNECTION
// ============================================
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let db;
let usersCollection;
let ticketsCollection;
let bookingCollection;
let transactionsCollection;

async function connectDB() {
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log("✅ MongoDB Connected Successfully");

    db = client.db("ticketbari_db");
    usersCollection = db.collection("users");
    ticketsCollection = db.collection("ticketsCollection");
    bookingCollection = db.collection("bookingCollection");
    transactionsCollection = db.collection("transactionCollection");

    // Create indexes for better performance
    await ticketsCollection.createIndex({ status: 1, isAdvertised: 1 });
    await ticketsCollection.createIndex({ vendorId: 1 });
    await ticketsCollection.createIndex({ from: 1, to: 1 });
    await bookingCollection.createIndex({ userId: 1 });
    await bookingCollection.createIndex({ ticketId: 1 });

    console.log("📦 Database: ticketbari_db");
    console.log("✅ Collections and indexes ready");
  } catch (error) {
    console.error("❌ MongoDB Connection Error:", error);
    process.exit(1);
  }
}

connectDB();

// ============================================
// ROUTES
// ============================================

// Health Check
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    message: "Server is running!",
    timestamp: new Date().toISOString(),
    database: db ? "Connected" : "Disconnected",
  });
});

// ============================================
// TICKET ROUTES
// ============================================

// GET all approved tickets with filters, sort, pagination
app.get("/api/tickets", async (req, res) => {
  try {
    const { from, to, transportType, sortBy, page = 1, limit = 9 } = req.query;

    // Build query
    let query = { status: "approved" };

    if (from) query.from = { $regex: from, $options: "i" };
    if (to) query.to = { $regex: to, $options: "i" };
    if (transportType) query.transportType = transportType;

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Build sort
    let sort = {};
    if (sortBy === "price-asc") sort.price = 1;
    if (sortBy === "price-desc") sort.price = -1;
    if (!sortBy) sort.createdAt = -1;

    const tickets = await ticketsCollection
      .find(query)
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit))
      .toArray();

    const total = await ticketsCollection.countDocuments(query);

    res.json({
      success: true,
      data: tickets,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// GET single ticket by ID
app.get("/api/tickets/:id", async (req, res) => {
  try {
    const ticket = await ticketsCollection.findOne({
      _id: new ObjectId(req.params.id),
    });

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: "Ticket not found",
      });
    }

    res.json({ success: true, data: ticket });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// GET latest tickets (for homepage)
app.get("/api/tickets/latest/all", async (req, res) => {
  try {
    const tickets = await ticketsCollection
      .find({ status: "approved" })
      .sort({ createdAt: -1 })
      .limit(8)
      .toArray();

    res.json({ success: true, data: tickets });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// GET advertised tickets (for homepage)
app.get("/api/tickets/advertised/all", async (req, res) => {
  try {
    const tickets = await ticketsCollection
      .find({
        status: "approved",
        isAdvertised: true,
      })
      .limit(6)
      .toArray();

    res.json({ success: true, data: tickets });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// GET vendor's tickets
app.get("/api/tickets/vendor/:vendorId", async (req, res) => {
  try {
    const tickets = await ticketsCollection
      .find({ vendorId: req.params.vendorId })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ success: true, data: tickets });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// POST create ticket (vendor only)
app.post("/api/tickets", async (req, res) => {
  try {
    const ticketData = {
      ...req.body,
      status: "pending",
      isAdvertised: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await ticketsCollection.insertOne(ticketData);
    const newTicket = await ticketsCollection.findOne({
      _id: result.insertedId,
    });

    res.status(201).json({
      success: true,
      message: "Ticket added successfully. Waiting for admin approval.",
      data: newTicket,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// PUT update ticket
app.put("/api/tickets/:id", async (req, res) => {
  try {
    const updateData = {
      ...req.body,
      updatedAt: new Date(),
    };

    const result = await ticketsCollection.findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: updateData },
      { returnDocument: "after" }
    );

    if (!result.value) {
      return res.status(404).json({
        success: false,
        message: "Ticket not found",
      });
    }

    res.json({
      success: true,
      message: "Ticket updated successfully",
      data: result.value,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// DELETE ticket
app.delete("/api/tickets/:id", async (req, res) => {
  try {
    const result = await ticketsCollection.deleteOne({
      _id: new ObjectId(req.params.id),
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Ticket not found",
      });
    }

    res.json({
      success: true,
      message: "Ticket deleted successfully",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ============================================
// BOOKING ROUTES
// ============================================

// POST create booking
app.post("/api/bookings", async (req, res) => {
  try {
    const { ticketId, bookingQuantity, userId, userName, userEmail } = req.body;

    // Validate ticket exists and has enough quantity
    const ticket = await ticketsCollection.findOne({
      _id: new ObjectId(ticketId),
    });

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: "Ticket not found",
      });
    }

    if (ticket.ticketQuantity < bookingQuantity) {
      return res.status(400).json({
        success: false,
        message: "Not enough tickets available",
      });
    }

    // Create booking
    const bookingData = {
      userId,
      userName,
      userEmail,
      ticketId,
      ticketTitle: ticket.title,
      bookingQuantity: parseInt(bookingQuantity),
      unitPrice: ticket.price,
      totalPrice: ticket.price * bookingQuantity,
      from: ticket.from,
      to: ticket.to,
      departureDate: ticket.departureDate,
      departureTime: ticket.departureTime,
      status: "pending",
      transactionId: null,
      paymentDate: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await bookingCollection.insertOne(bookingData);
    const newBooking = await bookingCollection.findOne({
      _id: result.insertedId,
    });

    res.status(201).json({
      success: true,
      message: "Booking created successfully. Waiting for vendor approval.",
      data: newBooking,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// GET user's bookings
app.get("/api/bookings/user/:userId", async (req, res) => {
  try {
    const bookings = await bookingCollection
      .find({ userId: req.params.userId })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ success: true, data: bookings });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// GET bookings for vendor's tickets
app.get("/api/bookings/vendor/:vendorId", async (req, res) => {
  try {
    const vendorTickets = await ticketsCollection
      .find({ vendorId: req.params.vendorId })
      .project({ _id: 1 })
      .toArray();

    const ticketIds = vendorTickets.map((t) => t._id.toString());

    const bookings = await bookingCollection
      .find({ ticketId: { $in: ticketIds } })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ success: true, data: bookings });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// PUT update booking status (accept/reject)
app.put("/api/bookings/:id/status", async (req, res) => {
  try {
    const { status } = req.body;

    const result = await bookingCollection.findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
          status,
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after" }
    );

    if (!result.value) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    res.json({
      success: true,
      message: `Booking ${status} successfully`,
      data: result.value,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// PUT update booking after payment
app.put("/api/bookings/:id/payment", async (req, res) => {
  try {
    const { transactionId } = req.body;

    const booking = await bookingCollection.findOne({
      _id: new ObjectId(req.params.id),
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    // Update booking status
    const paymentDate = new Date();
    await bookingCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
          status: "paid",
          transactionId,
          paymentDate,
          updatedAt: new Date(),
        },
      }
    );

    // Reduce ticket quantity
    await ticketsCollection.updateOne(
      { _id: new ObjectId(booking.ticketId) },
      { $inc: { ticketQuantity: -booking.bookingQuantity } }
    );

    // Create transaction record
    await transactionsCollection.insertOne({
      transactionId,
      userId: booking.userId,
      bookingId: booking._id.toString(),
      ticketTitle: booking.ticketTitle,
      amount: booking.totalPrice,
      paymentDate,
      paymentMethod: "card",
      status: "completed",
      createdAt: new Date(),
    });

    const updatedBooking = await bookingCollection.findOne({
      _id: new ObjectId(req.params.id),
    });

    res.json({
      success: true,
      message: "Payment successful",
      data: updatedBooking,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// GET user's transactions
app.get("/api/transactions/user/:userId", async (req, res) => {
  try {
    const transactions = await transactionsCollection
      .find({ userId: req.params.userId })
      .sort({ paymentDate: -1 })
      .toArray();

    res.json({ success: true, data: transactions });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ============================================
// ADMIN ROUTES
// ============================================

// GET all tickets (for admin)
app.get("/api/admin/tickets", async (req, res) => {
  try {
    const tickets = await ticketsCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ success: true, data: tickets });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// PUT approve/reject ticket
app.put("/api/admin/tickets/:id/status", async (req, res) => {
  try {
    const { status } = req.body; // 'approved' or 'rejected'

    const result = await ticketsCollection.findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
          status,
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after" }
    );

    if (!result.value) {
      return res.status(404).json({
        success: false,
        message: "Ticket not found",
      });
    }

    res.json({
      success: true,
      message: `Ticket ${status} successfully`,
      data: result.value,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// PUT toggle ticket advertisement
app.put("/api/admin/tickets/:id/advertise", async (req, res) => {
  try {
    const { isAdvertised } = req.body;

    // Check current advertised count
    if (isAdvertised) {
      const count = await ticketsCollection.countDocuments({
        isAdvertised: true,
        _id: { $ne: new ObjectId(req.params.id) },
      });

      if (count >= 6) {
        return res.status(400).json({
          success: false,
          message: "Maximum 6 tickets can be advertised at a time",
        });
      }
    }

    const result = await ticketsCollection.findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
          isAdvertised,
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after" }
    );

    if (!result.value) {
      return res.status(404).json({
        success: false,
        message: "Ticket not found",
      });
    }

    res.json({
      success: true,
      message: isAdvertised ? "Ticket advertised" : "Advertisement removed",
      data: result.value,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// GET all users (for admin)
app.get("/api/admin/users", async (req, res) => {
  try {
    const users = await usersCollection
      .find({})
      .project({ password: 0 }) // Don't send passwords
      .toArray();

    res.json({ success: true, data: users });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// PUT update user role
app.put("/api/admin/users/:id/role", async (req, res) => {
  try {
    const { role } = req.body; // 'user', 'vendor', or 'admin'

    const result = await usersCollection.findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: { role } },
      { returnDocument: "after" }
    );

    if (!result.value) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    res.json({
      success: true,
      message: `User role updated to ${role}`,
      data: result.value,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// server/routes/paymentRoutes.js
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// Create checkout session
app.post("/payment/create-session", async (req, res) => {
  try {
    const { bookingId, amount, ticketTitle, successUrl, cancelUrl } = req.body;

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "bdt", // Bangladeshi Taka
            product_data: {
              name: ticketTitle,
            },
            unit_amount: amount * 100, // Stripe uses cents
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        bookingId: bookingId,
      },
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Webhook to handle successful payment
app.post("/payment/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle successful payment
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const bookingId = session.metadata.bookingId;

    // Update booking status
    await bookingCollection.updateOne(
      { _id: new ObjectId(bookingId) },
      {
        $set: {
          status: "paid",
          transactionId: session.payment_intent,
          paymentDate: new Date(),
        },
      }
    );

    // Reduce ticket quantity
    const booking = await bookingCollection.findOne({
      _id: new ObjectId(bookingId),
    });

    await ticketsCollection.updateOne(
      { _id: new ObjectId(booking.ticketId) },
      { $inc: { ticketQuantity: -booking.bookingQuantity } }
    );

    // Create transaction record
    await transactionsCollection.insertOne({
      transactionId: session.payment_intent,
      userId: booking.userId,
      bookingId: bookingId,
      ticketTitle: booking.ticketTitle,
      amount: booking.totalPrice,
      paymentDate: new Date(),
      status: "completed",
    });
  }

  res.json({ received: true });
});

// PUT mark vendor as fraud
app.put("/api/admin/users/:id/fraud", async (req, res) => {
  try {
    const { isFraud } = req.body;

    const result = await usersCollection.findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: { isFraud } },
      { returnDocument: "after" }
    );

    if (!result.value) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // If marking as fraud, hide all vendor's tickets
    if (isFraud) {
      await ticketsCollection.updateMany(
        { vendorId: req.params.id },
        { $set: { status: "rejected" } }
      );
    }

    res.json({
      success: true,
      message: isFraud ? "Vendor marked as fraud" : "Fraud status removed",
      data: result.value,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ============================================
// ERROR HANDLING
// ============================================

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

// Global error handler
app.use((error, req, res, next) => {
  console.error("Server Error:", error);
  res.status(500).json({
    success: false,
    message: "Internal server error",
    error: process.env.NODE_ENV === "development" ? error.message : undefined,
  });
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 http://localhost:${PORT}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down gracefully...");
  await client.close();
  console.log("MongoDB connection closed !");
  process.exit(0);
});
