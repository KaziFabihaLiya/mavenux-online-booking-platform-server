// ============================================
// UPDATED index.js - COMPLETE BACKEND WITH JWT & STRIPE
// ============================================

const express = require("express");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const cors = require("cors");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");
const admin = require("firebase-admin");
const stripe = require("stripe");
dotenv.config();
const app = express();
const PORT = process.env.PORT || 5000;

const admin = require("firebase-admin");
const serviceAccountKey = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const serviceAccount = require(serviceAccountKey);

admin.initializeApp({
  
  credential: admin.credential.cert(serviceAccount),
  
},
console.log("✅ Firebase Admin Initialized"),);

// JWT VERIFICATION MIDDLEWARE
// JWT Verification Middleware
const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({
      success: false,
      message: "No token provided",
    });
  }

  const token = authHeader.split(" ")[1]; // Bearer TOKEN

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({
        success: false,
        message: "Invalid or expired token",
      });
    }
    req.user = decoded;
    next();
  });
};

// ============================================
// STRIPE INIT (Now after dotenv.config())
// ============================================
let stripeClient;
if (process.env.STRIPE_SECRET_KEY) {
  stripeClient = stripe(process.env.STRIPE_SECRET_KEY);
  console.log("Stripe initialized");
} else {
  console.warn("STRIPE_SECRET_KEY missing - Payments disabled");
  stripeClient = { warning: true }; // Stub
}
// ============================================
// MIDDLEWARE
// ============================================
app.use(
  cors({
    origin: ["http://localhost:5173", "http://localhost:5174","http://localhost:3000"],
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



// Role verification middleware
const verifyRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: "Access denied. Insufficient permissions.",
      });
    }
    next();
  };
};

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

    db = client.db("MavenusDB");
    usersCollection = db.collection("users");
    ticketsCollection = db.collection("ticketsCollection");
    bookingCollection = db.collection("bookingCollection");
    transactionsCollection = db.collection("transactionCollection");

    // Create indexes
    await ticketsCollection.createIndex({ status: 1, isAdvertised: 1 });
    await ticketsCollection.createIndex({ vendorId: 1 });
    await ticketsCollection.createIndex({ from: 1, to: 1 });
    await bookingCollection.createIndex({ userId: 1 });
    await bookingCollection.createIndex({ ticketId: 1 });
    await usersCollection.createIndex({ email: 1 }, { unique: true });
    await usersCollection.createIndex({ uid: 1 }, { unique: true });

    console.log("Database: MavenusDB");
    console.log("Collections and indexes ready");
  } catch (error) {
    console.error("MongoDB Connection Error:", error);
    process.exit(1);
  }
}

connectDB();



// Get current user info
app.get("/api/auth/me", verifyToken, async (req, res) => {
  try {
    const user = await usersCollection.findOne(
      { uid: req.user.uid },
      { projection: { createdAt: 0, updatedAt: 0 } } // Clean projection
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    res.json({ success: true, data: user });
  } catch (error) {
    console.error("Get user error:", error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});
// Update user profile
app.put("/api/auth/profile", async (req, res) => {
  try {
    const { name, photoURL } = req.body;

    const result = await usersCollection.findOneAndUpdate(
      { uid: req.user.uid },
      {
        $set: {
          name,
          photoURL,
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after" }
    );

    res.json({
      success: true,
      message: "Profile updated successfully",
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
// TICKET ROUTES (PROTECTED)
// ============================================

// GET all approved tickets
app.get("/api/tickets", async (req, res) => {
  try {
    const { from, to, transportType, sortBy, page = 1, limit = 9 } = req.query;

    let query = { status: "approved" };

    if (from) query.from = { $regex: from, $options: "i" };
    if (to) query.to = { $regex: to, $options: "i" };
    if (transportType) query.transportType = transportType;

    const skip = (parseInt(page) - 1) * parseInt(limit);

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

// GET single ticket
app.get("/api/tickets/:id", verifyToken, async (req, res) => {
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

// GET latest tickets
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

// GET advertised tickets
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
app.get("/api/tickets/vendor/:vendorId", verifyToken, async (req, res) => {
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
app.post(
  "/api/tickets",
   verifyToken,
  verifyRole("vendor", "admin"),
  async (req, res) => {
    try {
      // Check if vendor is marked as fraud
      const vendor = await usersCollection.findOne({ uid: req.user.uid });

      if (vendor.isFraud) {
        return res.status(403).json({
          success: false,
          message: "Your account has been flagged. Cannot add tickets.",
        });
      }

      const ticketData = {
        ...req.body,
        vendorId: req.user.userId,
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
  }
);

// PUT update ticket
app.put(
  "/api/tickets/:id",
   verifyToken,
  verifyRole("vendor", "admin"),
  async (req, res) => {
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
  }
);

// DELETE ticket
app.delete(
  "/api/tickets/:id",
   verifyToken,
  verifyRole("vendor", "admin"),
  async (req, res) => {
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
  }
);

// ============================================
// BOOKING ROUTES (PROTECTED)
// ============================================

// POST create booking
app.post("/api/bookings", verifyToken,  async (req, res) => {
  try {
    const { ticketId, bookingQuantity } = req.body;

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

    const user = await usersCollection.findOne({ uid: req.user.uid });

    const bookingData = {
      userId: user._id.toString(),
      userName: user.name,
      userEmail: user.email,
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
app.get("/api/bookings/user/:userId",  verifyToken,  async (req, res) => {
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
app.get(
  "/api/bookings/vendor/:vendorId",
  verifyToken,
  verifyRole("vendor", "admin"),
  async (req, res) => {
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
  }
);

// PUT update booking status
app.put(
  "/api/bookings/:id/status",
  verifyToken,
  verifyRole("vendor", "admin"),
  async (req, res) => {
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
  }
);

// ============================================
// STRIPE PAYMENT ROUTES
// ============================================

// Create Stripe checkout session
app.post("/api/payment/create-session", verifyToken ,  async (req, res) => {
  try {
    const { bookingId } = req.body;

    const booking = await bookingCollection.findOne({
      _id: new ObjectId(bookingId),
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    if (booking.status !== "accepted") {
      return res.status(400).json({
        success: false,
        message: "Booking must be accepted by vendor before payment",
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "bdt",
            product_data: {
              name: booking.ticketTitle,
              description: `${booking.from} → ${booking.to}`,
            },
            unit_amount: Math.round(booking.totalPrice * 100),
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${process.env.CLIENT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_URL}/dashboard/user/bookings`,
      metadata: {
        bookingId: bookingId,
        userId: booking.userId,
      },
    });

    res.json({
      success: true,
      sessionId: session.id,
      url: session.url,
    });
  } catch (error) {
    console.error("Stripe error:", error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// Verify payment and update booking
app.post("/api/payment/verify", verifyToken, async (req, res) => {
  try {
    const { sessionId } = req.body;

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status === "paid") {
      const bookingId = session.metadata.bookingId;
      const booking = await bookingCollection.findOne({
        _id: new ObjectId(bookingId),
      });

      // Update booking
      await bookingCollection.updateOne(
        { _id: new ObjectId(bookingId) },
        {
          $set: {
            status: "paid",
            transactionId: session.payment_intent,
            paymentDate: new Date(),
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
        transactionId: session.payment_intent,
        userId: booking.userId,
        bookingId: bookingId,
        ticketTitle: booking.ticketTitle,
        amount: booking.totalPrice,
        paymentDate: new Date(),
        paymentMethod: "card",
        status: "completed",
        createdAt: new Date(),
      });

      res.json({
        success: true,
        message: "Payment verified successfully",
      });
    } else {
      res.status(400).json({
        success: false,
        message: "Payment not completed",
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// GET user's transactions
app.get("/api/transactions/user/:userId", verifyToken, async (req, res) => {
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
// ADMIN ROUTES (PROTECTED)
// ============================================

// GET all tickets
app.get(
  "/api/admin/tickets",
   verifyToken ,
  verifyRole("admin"),
  async (req, res) => {
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
  }
);

// PUT approve/reject ticket
app.put(
  "/api/admin/tickets/:id/status",
   verifyToken ,
  verifyRole("admin"),
  async (req, res) => {
    try {
      const { status } = req.body;

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
  }
);

// PUT toggle advertisement
app.put(
  "/api/admin/tickets/:id/advertise",
   verifyToken ,
  verifyRole("admin"),
  async (req, res) => {
    try {
      const { isAdvertised } = req.body;

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
  }
);

// GET all users
app.get(
  "/api/admin/users",
   verifyToken ,
  verifyRole("admin"),
  async (req, res) => {
    try {
      const users = await usersCollection
        .find({})
        .project({ password: 0 })
        .toArray();

      res.json({ success: true, data: users });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }
);

// PUT update user role
app.put(
  "/api/admin/users/:id/role",
   verifyToken ,
  verifyRole("admin"),
  async (req, res) => {
    try {
      const { role } = req.body;

      const result = await usersCollection.findOneAndUpdate(
        { _id: new ObjectId(req.params.id) },
        { $set: { role, updatedAt: new Date() } },
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
  }
);

// PUT mark vendor as fraud
app.put(
  "/api/admin/users/:id/fraud",
   verifyToken , 
  verifyRole("admin"),
  async (req, res) => {
    try {
      const { isFraud } = req.body;

      const result = await usersCollection.findOneAndUpdate(
        { _id: new ObjectId(req.params.id) },
        { $set: { isFraud, updatedAt: new Date() } },
        { returnDocument: "after" }
      );

      if (!result.value) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

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
  }
);

// ============================================
// ERROR HANDLING
// ============================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

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
  console.log(`🔒 JWT Authentication enabled`);
  console.log(`💳 Stripe Payment enabled`);
});

process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down gracefully...");
  await client.close();
  console.log("MongoDB connection closed!");
  process.exit(0);
});
