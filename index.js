// ============================================
// UPDATED index.js - COMPLETE BACKEND WITH JWT & STRIPE
// ============================================

const express = require("express");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const cors = require("cors");
const dotenv = require("dotenv");
const jwt = require("jsonwebtoken");

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
const verifyToken = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(" ")[1];
  console.log(token);
  if (!token) return res.status(401).send({ message: "Unauthorized Access!" });
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log(decoded);
    next();
  } catch (err) {
    console.log(err);
    return res.status(401).send({ message: "Unauthorized Access!", err });
  }
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

app.use(express.json({ limit: "5mb" }));
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
let roleRequestsCollection;

async function connectDB() {
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log("✅ MongoDB Connected Successfully");

    db = client.db("MavenusDB");
    

    // In connectDB() function, add:
    roleRequestsCollection = db.collection("roleRequests");
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

    console.log("Database: MavenusDB");
    console.log("Collections and indexes ready");
  } catch (error) {
    console.error("MongoDB Connection Error:", error);
    process.exit(1);
  }
}

// GET current user info (for useRole hook)
// ✅ FIX 1: GET current user info (FIXED - add better error handling)
app.get("/api/auth/me", verifyToken, async (req, res) => {
  try {
    console.log("🔍 /api/auth/me - Email from token:", req.tokenEmail); // Debug
    
    const user = await usersCollection.findOne({ email: req.tokenEmail });

    if (!user) {
      console.log("❌ /api/auth/me - User not found in database"); // Debug
      return res.status(404).json({
        success: false,
        message: "User not found in database. Please re-login.",
      });
    }

    console.log("✅ /api/auth/me - User found:", user.email, "Role:", user.role); // Debug

    res.json({
      success: true,
      data: {
        _id: user._id,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
        role: user.role || "user", // Always return a role
        isFraud: user.isFraud || false,
      },
    });
  } catch (error) {
    console.error("❌ /api/auth/me - Error:", error); // Debug
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// ✅ FIX 2: User registration/login route (ENSURE ROLE IS SAVED)
app.post("/user", async (req, res) => {
  try {
    const userData = req.body;
    console.log("🔍 /user - Received data:", userData.email); // Debug

    const query = { email: userData.email };
    
    // Check if user exists
    const existingUser = await usersCollection.findOne(query);
    
    if (existingUser) {
      console.log("✅ /user - Existing user found:", existingUser.email, "Role:", existingUser.role); // Debug
      
      // User exists - ONLY update last login and profile data, DON'T CHANGE ROLE
      await usersCollection.updateOne(
        query,
        {
          $set: {
            last_loggedIn: new Date().toISOString(),
            photoURL: userData.photoURL || existingUser.photoURL,
            displayName: userData.displayName || existingUser.displayName
          }
        }
      );
      
      // Fetch updated user
      const updatedUser = await usersCollection.findOne(query);
      
      return res.send({
        message: "User logged in",
        user: updatedUser,
      });
    }
    
    // New user - create with "user" role
    const newUser = {
      email: userData.email,
      displayName: userData.displayName || "User",
      photoURL: userData.photoURL || null,
      uid: userData.uid,
      role: "user", // ✅ CRITICAL: Default role for new users
      isFraud: false,
      created_at: new Date().toISOString(),
      last_loggedIn: new Date().toISOString(),
    };
    
    const result = await usersCollection.insertOne(newUser);
    
    console.log("✅ /user - New user created:", newUser.email, "Role:", newUser.role); // Debug
    
    res.send({
      message: "User created",
      user: newUser,
    });
  } catch (err) {
    console.error("❌ /user - Error:", err); // Debug
    res.status(500).send({ 
      error: "Server error during user save/update",
      details: err.message 
    });
  }
});

// app.post("/user", async (req, res) => {
//   try {
//     const userData = req.body;

//     const query = { email: userData.email };
//     const update = {
//       $set: {
//         email: userData.email,
//         displayName: userData.displayName,
//         photoURL: userData.photoURL,
//         uid: userData.uid, // Firebase UID
//         role: userData.role || "user",
//         last_loggedIn: new Date().toISOString(),
//       },
//       $setOnInsert: {
//         created_at: new Date().toISOString(),
//       },
//     };

//     const result = await usersCollection.updateOne(query, update, {
//       upsert: true,
//     });

//     // Return the user document
//     const user = await usersCollection.findOne(query);

//     res.send({
//       message: result.matchedCount > 0 ? "User updated" : "User created",
//       user,
//     });
//   } catch (err) {
//     console.error("Error in /user:", err);
//     res.status(500).send({ error: "Server error during user save/update" });
//   }
// });

    // get a user's role
    app.get("/user/role", verifyToken, async (req, res) => {
      const result = await usersCollection.findOne({ email: req.tokenEmail });
      res.send({ role: result?.role });
    });
    // ============================================
    // TICKET ROUTES (PROTECTED)
    // ============================================

    // GET all approved tickets
    app.get("/api/tickets", async (req, res) => {
      try {
        const {
          from,
          to,
          transportType,
          sortBy,
          page = 1,
          limit = 9,
        } = req.query;

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

    // Role Request handling 
    app.post("/api/role-requests", verifyToken, async (req, res) => {
      try {
        const { requestedRole } = req.body;

        // Validate requested role
        if (!["vendor", "admin"].includes(requestedRole)) {
          return res.status(400).json({
            success: false,
            message: "Invalid role. Can only request: vendor or admin",
          });
        }

        // Get current user
        const user = await usersCollection.findOne({ email: req.tokenEmail });

        if (!user) {
          return res.status(404).json({
            success: false,
            message: "User not found",
          });
        }

        // Check if user already has this role or higher
        if (user.role === requestedRole) {
          return res.status(400).json({
            success: false,
            message: `You are already a ${requestedRole}`,
          });
        }

        if (user.role === "admin") {
          return res.status(400).json({
            success: false,
            message: "You already have admin privileges",
          });
        }

        // Check for existing pending request
        const existingRequest = await roleRequestsCollection.findOne({
          userEmail: req.tokenEmail,
          status: "pending",
        });

        if (existingRequest) {
          return res.status(400).json({
            success: false,
            message: "You already have a pending request",
          });
        }

        // Create role request
        const roleRequest = {
          userId: user._id.toString(),
          userEmail: user.email,
          userName: user.displayName || "User",
          userPhoto: user.photoURL || null,
          currentRole: user.role,
          requestedRole: requestedRole,
          status: "pending", // pending, approved, rejected
          requestDate: new Date().toISOString(),
          processedBy: null,
          processedDate: null,
          rejectionReason: null,
        };

        const result = await roleRequestsCollection.insertOne(roleRequest);
        const newRequest = await roleRequestsCollection.findOne({
          _id: result.insertedId,
        });

        console.log("✅ Role request created:", newRequest);

        res.status(201).json({
          success: true,
          message: `${requestedRole} request submitted successfully`,
          data: newRequest,
        });
      } catch (error) {
        console.error("Error creating role request:", error);
        res.status(500).json({
          success: false,
          message: error.message,
        });
      }
    });

    // GET: Get user's own role requests
    app.get("/api/role-requests/my-requests", verifyToken, async (req, res) => {
      try {
        const requests = await roleRequestsCollection
          .find({ userEmail: req.tokenEmail })
          .sort({ requestDate: -1 })
          .toArray();

        res.json({
          success: true,
          data: requests,
        });
      } catch (error) {
        console.error("Error fetching requests:", error);
        res.status(500).json({
          success: false,
          message: error.message,
        });
      }
    });

    // GET: Get all pending role requests (Admin only)
    app.get("/api/admin/role-requests", verifyToken, async (req, res) => {
      try {
        // Verify user is admin
        const adminUser = await usersCollection.findOne({
          email: req.tokenEmail,
        });

        if (adminUser.role !== "admin") {
          return res.status(403).json({
            success: false,
            message: "Only admins can access this endpoint",
          });
        }

        const { status } = req.query;

        let query = {};
        if (status && ["pending", "approved", "rejected"].includes(status)) {
          query.status = status;
        }

        const requests = await roleRequestsCollection
          .find(query)
          .sort({ requestDate: -1 })
          .toArray();

        res.json({
          success: true,
          data: requests,
        });
      } catch (error) {
        console.error("Error fetching role requests:", error);
        res.status(500).json({
          success: false,
          message: error.message,
        });
      }
    });

    // ============================================
// FIXED: PUT /api/admin/role-requests/:requestId
// Replace this in your index.js
// ============================================

app.put(
  "/api/admin/role-requests/:requestId",
  verifyToken,
  async (req, res) => {
    try {
      const { action, rejectionReason } = req.body; // "approve" or "reject"

      console.log("🔍 Processing request:", req.params.requestId, "Action:", action);

      // Verify user is admin
      const adminUser = await usersCollection.findOne({
        email: req.tokenEmail,
      });

      if (adminUser.role !== "admin") {
        return res.status(403).json({
          success: false,
          message: "Only admins can process role requests",
        });
      }

      if (!["approve", "reject"].includes(action)) {
        return res.status(400).json({
          success: false,
          message: "Invalid action. Must be 'approve' or 'reject'",
        });
      }

      // Get the request
      const request = await roleRequestsCollection.findOne({
        _id: new ObjectId(req.params.requestId),
      });

      if (!request) {
        return res.status(404).json({
          success: false,
          message: "Request not found",
        });
      }

      if (request.status !== "pending") {
        return res.status(400).json({
          success: false,
          message: `Request already ${request.status}`,
        });
      }

      console.log("✅ Request found:", request.userEmail, "→", request.requestedRole);

      // If approving, update user's role
      if (action === "approve") {
        // ✅ FIX: Use email to find user, not _id
        const userToUpdate = await usersCollection.findOne({ 
          email: request.userEmail 
        });

        console.log("🔍 Looking for user:", request.userEmail);

        if (!userToUpdate) {
          console.log("❌ User not found in database:", request.userEmail);
          return res.status(404).json({
            success: false,
            message: `User not found: ${request.userEmail}. They may need to log in again.`,
          });
        }

        console.log("✅ User found:", userToUpdate.email, "Current role:", userToUpdate.role);

        // Update the user's role
        const updateResult = await usersCollection.findOneAndUpdate(
          { email: request.userEmail }, // ✅ Use email, not _id
          {
            $set: {
              role: request.requestedRole,
              updatedAt: new Date().toISOString(),
            },
          },
          { returnDocument: "after" }
        );

        if (!updateResult.value) {
          console.log("❌ Failed to update user");
          return res.status(500).json({
            success: false,
            message: "Failed to update user role",
          });
        }

        console.log(
          `✅ User role updated: ${request.userEmail} → ${request.requestedRole}`
        );
      }

      // Update request status
      const updatedRequest = await roleRequestsCollection.findOneAndUpdate(
        { _id: new ObjectId(req.params.requestId) },
        {
          $set: {
            status: action === "approve" ? "approved" : "rejected",
            processedBy: adminUser.email,
            processedDate: new Date().toISOString(),
            rejectionReason: action === "reject" ? rejectionReason : null,
          },
        },
        { returnDocument: "after" }
      );

      console.log("✅ Request updated to:", updatedRequest.value.status);

      res.json({
        success: true,
        message: `Request ${action}d successfully`,
        data: updatedRequest.value,
      });
    } catch (error) {
      console.error("❌ Error processing role request:", error);
      res.status(500).json({
        success: false,
        message: error.message,
      });
    }
  }
);

    // DELETE: Cancel own pending request
    app.delete(
      "/api/role-requests/:requestId",
      verifyToken,
      async (req, res) => {
        try {
          const request = await roleRequestsCollection.findOne({
            _id: new ObjectId(req.params.requestId),
            userEmail: req.tokenEmail,
          });

          if (!request) {
            return res.status(404).json({
              success: false,
              message: "Request not found",
            });
          }

          if (request.status !== "pending") {
            return res.status(400).json({
              success: false,
              message: "Can only cancel pending requests",
            });
          }

          await roleRequestsCollection.deleteOne({
            _id: new ObjectId(req.params.requestId),
          });

          res.json({
            success: true,
            message: "Request cancelled successfully",
          });
        } catch (error) {
          console.error("Error cancelling request:", error);
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
// FIXED: POST create booking - Update this in your index.js
// FIXED: POST create booking - Update this in your index.js
app.post("/api/bookings", verifyToken, async (req, res) => {
  try {
    const { ticketId, bookingQuantity } = req.body;

    // Validate input
    if (!ticketId || !bookingQuantity) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields: ticketId and bookingQuantity",
      });
    }

    // Get ticket
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

    // FIX: Get user from MongoDB using tokenEmail
    const user = await usersCollection.findOne({ email: req.tokenEmail });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found in database. Please re-login.",
      });
    }

    // Create booking with proper user data
    const bookingData = {
      userId: user._id.toString(), // MongoDB user ID
      userName: user.displayName || user.name || "User",
      userEmail: user.email,
      ticketId: ticketId,
      ticketTitle: ticket.title,
      bookingQuantity: parseInt(bookingQuantity),
      unitPrice: ticket.price,
      totalPrice: ticket.price * bookingQuantity,
      from: ticket.from,
      to: ticket.to,
      departureDate: ticket.departureDate,
      departureTime: ticket.departureTime,
      transportType: ticket.transportType,
      image: ticket.image, // Add image for display
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
    console.error("Booking creation error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to create booking",
      error: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
});

    // FIXED: GET user's bookings - Update this in your index.js
app.get("/api/bookings/user/", verifyToken, async (req, res) => {
  try {
    // FIX: Get user from MongoDB first
    const user = await usersCollection.findOne({ email: req.tokenEmail });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Get bookings using MongoDB user ID
    const bookings = await bookingCollection
      .find({ userId: user._id.toString() })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ 
      success: true, 
      data: bookings 
    });
  } catch (error) {
    console.error("Get bookings error:", error);
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
    app.post("/api/payment/create-session", verifyToken, async (req, res) => {
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
      verifyToken,
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
      verifyToken,

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
      verifyToken,
   
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
            message: isAdvertised
              ? "Ticket advertised"
              : "Advertisement removed",
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
      verifyToken,
      
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
      verifyToken,
      
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
      verifyToken,
   
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
            message: isFraud
              ? "Vendor marked as fraud"
              : "Fraud status removed",
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

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔒 JWT Authentication enabled`);
    console.log(`💳 Stripe Payment enabled`);
  });
});
// ============================================
// START SERVER
// ============================================
// app.listen(PORT, () => {
//   console.log(`🚀 Server running on port ${PORT}`);
//   console.log(`🔒 JWT Authentication enabled`);
//   console.log(`💳 Stripe Payment enabled`);
// });

// process.on("SIGNIN", async () => {
//   console.log("\n🛑 Shutting down gracefully...");
//   await client.close();
//   console.log("MongoDB connection closed!");
//   process.exit(0);
// });
