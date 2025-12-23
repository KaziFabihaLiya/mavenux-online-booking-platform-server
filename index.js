//  
// UPDATED index.js - COMPLETE BACKEND WITH JWT & STRIPE
//  

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
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // Production: Load from environment variable (Render)
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  // Local development fallback: Load from file (safe locally)
  serviceAccount = require("./serviceAccountKey.json");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

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

//  
// STRIPE INIT (Now after dotenv.config())
//  
let stripeClient;
if (process.env.STRIPE_SECRET_KEY) {
  stripeClient = stripe(process.env.STRIPE_SECRET_KEY);
  console.log("Stripe initialized");
} else {
  console.warn("STRIPE_SECRET_KEY missing - Payments disabled");
  stripeClient = { warning: true }; // Stub
}
//  
// MIDDLEWARE
//  
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:3000",
      "https://mavenux-online-booking-platform-cli.vercel.app",
    ],
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

// Simple health check route for debugging proxy/connectivity issues
app.get("/api/health", (req, res) => {
  console.log("🔔 /api/health ping");
  res.json({ success: true, status: "ok", time: new Date().toISOString() });
});

//  
// MONGODB CONNECTION
//  
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
    // Added index to make vendorEmail queries fast and reliable
    await ticketsCollection.createIndex({ vendorEmail: 1 });
    await ticketsCollection.createIndex({ from: 1, to: 1 });
    await bookingCollection.createIndex({ userId: 1 });
    await bookingCollection.createIndex({ ticketId: 1 });
    await usersCollection.createIndex({ email: 1 }, { unique: true });
    await bookingCollection.createIndex({ vendorId: 1 });
    await bookingCollection.createIndex({ vendorEmail: 1 }); 

    console.log("Database: MavenusDB");
    console.log("Collections and indexes ready");
  } catch (error) {
    console.error("MongoDB Connection Error:", error);
    process.exit(1);
  }
}

// GET current user info (for useRole hook)
// FIX 1: GET current user info (FIXED - add better error handling)
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

    console.log(
      "✅ /api/auth/me - User found:",
      user.email,
      "Role:",
      user.role
    ); // Debug

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

// DEBUG: echo token info and resolved user - use only for local debugging
app.get("/api/debug/me", verifyToken, async (req, res) => {
  try {
    console.log("🔍 /api/debug/me - tokenEmail:", req.tokenEmail);
    const user = await usersCollection.findOne({ email: req.tokenEmail });
    return res.json({
      success: true,
      tokenEmail: req.tokenEmail,
      user: user || null,
    });
  } catch (err) {
    console.error("/api/debug/me error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// FIX 2: User registration/login route (ENSURE ROLE IS SAVED)
app.post("/api/user", async (req, res) => {
  try {
    const userData = req.body;
    console.log("🔍 /user - Received data:", userData.email); // Debug

    // If a password is provided (optional), validate it server-side
    if (userData.password) {
      const p = userData.password;
      const pwdErrors = [];
      if (typeof p !== "string" || p.length < 6)
        pwdErrors.push("Password must be at least 6 characters long.");
      if (!/[A-Z]/.test(p))
        pwdErrors.push("Password must contain at least one uppercase letter.");
      if (!/[a-z]/.test(p))
        pwdErrors.push("Password must contain at least one lowercase letter.");
      if (pwdErrors.length > 0) {
        return res
          .status(400)
          .json({ success: false, message: pwdErrors.join(" ") });
      }
    }

    const query = { email: userData.email };

    // Check if user exists
    const existingUser = await usersCollection.findOne(query);

    if (existingUser) {
      console.log(
        "✅ /user - Existing user found:",
        existingUser.email,
        "Role:",
        existingUser.role
      ); // Debug

      // User exists - ONLY update last login and profile data, DON'T CHANGE ROLE
      await usersCollection.updateOne(query, {
        $set: {
          last_loggedIn: new Date().toISOString(),
          photoURL: userData.photoURL || existingUser.photoURL,
          displayName: userData.displayName || existingUser.displayName,
        },
      });

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

    console.log(
      "✅ /user - New user created:",
      newUser.email,
      "Role:",
      newUser.role
    ); // Debug

    res.send({
      message: "User created",
      user: newUser,
    });
  } catch (err) {
    console.error("❌ /user - Error:", err); // Debug
    res.status(500).send({
      error: "Server error during user save/update",
      details: err.message,
    });
  }
});

// get a user's role
app.get("/api/user/role", verifyToken, async (req, res) => {
  const result = await usersCollection.findOne({ email: req.tokenEmail });
  res.send({ role: result?.role });
});
//  
// TICKET ROUTES (PROTECTED)
//  

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

//  
// FIXED: GET /api/tickets/vendor/me
// Replace this endpoint in your index.js
//  

app.get("/api/tickets/vendor/me", verifyToken, async (req, res) => {
  try {
    const vendorEmail = req.tokenEmail;

    console.log("🎫 GET /api/tickets/vendor/me");
    console.log("📧 Vendor email from token:", vendorEmail);

    // Get vendor from database
    const vendor = await usersCollection.findOne({ email: vendorEmail });

    if (!vendor) {
      console.log("❌ Vendor not found in database:", vendorEmail);
      return res.json({
        success: true,
        data: [],
        message: "Vendor not found. Please log in again.",
      });
    }

    console.log("✅ Vendor found:", {
      _id: vendor._id.toString(),
      email: vendor.email,
      role: vendor.role,
    });

    // Get vendor ID as string
    const vendorIdString = vendor._id.toString();

    // ✅ SIMPLE QUERY - Try email first, then ID
    const tickets = await ticketsCollection
      .find({
        $or: [
          { vendorEmail: vendorEmail }, // Direct email match
          { vendorId: vendorIdString }, // String ID
          { vendorId: vendor._id }, // ObjectId
        ],
      })
      .sort({ createdAt: -1 })
      .toArray();

    console.log(`✅ Found ${tickets.length} tickets for ${vendorEmail}`);

    if (tickets.length > 0) {
      console.log("📦 Sample ticket:", {
        _id: tickets[0]._id.toString(),
        title: tickets[0].title,
        vendorId: tickets[0].vendorId,
        vendorIdType: typeof tickets[0].vendorId,
        vendorEmail: tickets[0].vendorEmail,
      });
    }

    // Prevent caching
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");

    res.json({
      success: true,
      data: tickets,
    });
  } catch (error) {
    console.error("❌ Error in /api/tickets/vendor/me:", error);
    res.status(500).json({
      success: false,
      message: error.message,
      data: [],
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
// DEBUG: Vendor ticket diagnostics (protected)
app.get("/api/debug/vendor-tickets", verifyToken, async (req, res) => {
  try {
    const vendorEmail = req.tokenEmail;
    console.log("🔎 /api/debug/vendor-tickets - Vendor:", vendorEmail);

    const vendor = await usersCollection.findOne({ email: vendorEmail });

    const escapedEmail = vendorEmail.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
    const emailRegex = new RegExp(`^\\s*${escapedEmail}\\s*$`, "i");

    const orConditions = [{ vendorEmail: emailRegex }];
    if (vendor) {
      orConditions.unshift({ vendorId: vendor._id.toString() });
      orConditions.unshift({ vendorId: vendor._id });
    }

    const query = { $or: orConditions };

    const counts = {
      idStr: vendor
        ? await ticketsCollection.countDocuments({
            vendorId: vendor._id.toString(),
          })
        : 0,
      idObj: vendor
        ? await ticketsCollection.countDocuments({ vendorId: vendor._id })
        : 0,
      email: await ticketsCollection.countDocuments({
        vendorEmail: emailRegex,
      }),
    };

    const samples = await ticketsCollection.find(query).limit(5).toArray();

    console.log(
      "🔎 /api/debug/vendor-tickets - counts:",
      counts,
      "samples:",
      samples.length
    );

    return res.json({ success: true, counts, samples });
  } catch (err) {
    console.error("🔎 /api/debug/vendor-tickets - error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST create ticket (vendor only)
app.post(
  "/api/tickets",
  verifyToken,

  async (req, res) => {
    try {
      // Resolve vendor by token email
      const vendor = await usersCollection.findOne({ email: req.tokenEmail });

      if (!vendor) {
        return res
          .status(404)
          .json({ success: false, message: "Vendor not found" });
      }

      if (vendor.isFraud) {
        return res.status(403).json({
          success: false,
          message: "Your account has been flagged. Cannot add tickets.",
        });
      }

      const ticketData = {
        ...req.body,
        vendorId: vendor._id.toString(),
        vendorName: vendor.displayName || vendor.name || "Vendor",
        vendorEmail: vendor.email,
        status: "pending",
        isAdvertised: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await ticketsCollection.insertOne(ticketData);
      const rawTicket = await ticketsCollection.findOne({
        _id: result.insertedId,
      });
      // Convert _id to string for consistent client handling
      const newTicket = { ...rawTicket, _id: rawTicket._id.toString() };

      console.log(
        "/api/tickets - Ticket created by:",
        vendor.email,
        "vendorId:",
        vendor._id.toString(),
        "insertedId:",
        result.insertedId
      );

      // Diagnostic checks after insert
      const foundByVendorId = await ticketsCollection
        .find({ vendorId: vendor._id.toString() })
        .toArray();
      const foundByVendorEmail = await ticketsCollection
        .find({ vendorEmail: vendor.email })
        .toArray();
      console.log(
        "/api/tickets - post-insert diagnostic: byVendorIdCount:",
        foundByVendorId.length,
        "byVendorEmailCount:",
        foundByVendorEmail.length,
        "newTicketStored:",
        rawTicket
      );

      // Prevent caching responses for newly created resources
      res.set(
        "Cache-Control",
        "no-store, no-cache, must-revalidate, proxy-revalidate"
      );
      res.set("Pragma", "no-cache");
      res.set("Expires", "0");

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

//  
// FIXED: PUT /api/admin/role-requests/:requestId
// Replace this in your index.js
//  

app.put(
  "/api/admin/role-requests/:requestId",
  verifyToken,
  async (req, res) => {
    try {
      const { action, rejectionReason } = req.body; // "approve" or "reject"

      console.log(
        "🔍 Processing request:",
        req.params.requestId,
        "Action:",
        action
      );

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

      console.log(
        "✅ Request found:",
        request.userEmail,
        "→",
        request.requestedRole
      );

      // If approving, update user's role
      if (action === "approve") {
        // ✅ FIX: Use email to find user, not _id
        const userToUpdate = await usersCollection.findOne({
          email: request.userEmail,
        });

        console.log("🔍 Looking for user:", request.userEmail);

        if (!userToUpdate) {
          console.log("❌ User not found in database:", request.userEmail);
          return res.status(404).json({
            success: false,
            message: `User not found: ${request.userEmail}. They may need to log in again.`,
          });
        }

        console.log(
          "✅ User found:",
          userToUpdate.email,
          "Current role:",
          userToUpdate.role
        );

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
app.delete("/api/role-requests/:requestId", verifyToken, async (req, res) => {
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
});

//  
// BOOKING ROUTES (PROTECTED)
//  

// POST create booking
// FIXED: POST create booking - Update this in your index.js
// POST a new booking 
app.post("/api/bookings", verifyToken, async (req, res) => {
  try {
    const { ticketId, bookingQuantity = 1, ...otherData } = req.body;
    const buyerEmail = req.tokenEmail; // From Firebase JWT

    if (!ticketId) {
      return res.status(400).json({
        success: false,
        message: "ticketId is required",
      });
    }
    const ticket = await ticketsCollection.findOne({
      _id: new ObjectId(ticketId),
      status: "accepted", // Optional: only allow booking accepted tickets
    });

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: "Ticket not found or not available for booking.",
      });
    }
    const ticketPrice = Number(ticket.price);
    if (isNaN(ticketPrice) || ticketPrice < 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid ticket price",
      });
    }
    const availableQuantity = ticket.ticketQuantity || 0;
    if (availableQuantity < bookingQuantity) {
      return res.status(400).json({
        success: false,
        message: `Only ${availableQuantity} ticket(s) available. Cannot book ${bookingQuantity}.`,
      });
    }
    const totalPrice = ticketPrice * bookingQuantity;

    const newBooking = {
      ...otherData,

      // Core booking info
      ticketId: ticket._id.toString(),
      ticketTitle: ticket.title,
      from: ticket.from,
      to: ticket.to,
      transportType: ticket.transportType,
      price: ticketPrice,              // Price per ticket (number)
      bookingQuantity: Number(bookingQuantity),
      totalPrice: totalPrice,          // ← This fixes the crash in MyBookedTickets
      vendorId: ticket.vendorId,
      vendorEmail: ticket.vendorEmail,
      vendorName: ticket.vendorName || "Unknown Vendor",
      userEmail: buyerEmail,
      departureDate: ticket.departureDate,
      departureTime: ticket.departureTime,
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = await bookingCollection.insertOne(newBooking);
    await ticketsCollection.updateOne(
      { _id: ticket._id },
      { $inc: { ticketQuantity: -bookingQuantity } }
    );
    res.json({
      success: true,
      message: "Booking request sent successfully!",
      bookingId: result.insertedId,
      data: {
        _id: result.insertedId,
        ...newBooking,
      },
    });
  } catch (error) {
    console.error("❌ Error creating booking:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create booking",
      error: error.message,
    });
  }
});

// FIXED: GET user's bookings - Update this in your index.js
app.get("/api/bookings/user", verifyToken, async (req, res) => {
  try {
    // 1. Get the email directly from the verified token
    const buyerEmail = req.tokenEmail;

    console.log("🔍 Fetching bookings for buyer:", buyerEmail);

    // 2. Query by userEmail (which we just added to the POST route)
    // We also check for 'userId' as a fallback just in case old data exists
    const bookings = await bookingCollection
      .find({
        $or: [
          { userEmail: buyerEmail },
          { customerEmail: buyerEmail }, // Some stripe setups use this field
        ],
      })
      .sort({ createdAt: -1 })
      .toArray();

    console.log(`✅ Found ${bookings.length} bookings for user`);

    res.json({
      success: true,
      data: bookings,
    });
  } catch (error) {
    console.error("❌ Get user bookings error:", error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});
// GET bookings for the authenticated vendor (convenience endpoint)
app.get("/api/bookings/vendor/me", verifyToken, async (req, res) => {
  try {
    const vendorEmail = req.tokenEmail;

    // 1. Find all tickets that belong to you
    const myTickets = await ticketsCollection
      .find({ vendorEmail: vendorEmail })
      .project({ _id: 1 })
      .toArray();

    // 2. Extract the IDs as strings and ObjectIds (for safety)
    const myTicketIds = myTickets.map((t) => t._id.toString());

    // 3. Find bookings that match your ticket IDs
    // This works even if the booking document doesn't have 'vendorEmail'
    const bookings = await bookingCollection
      .find({
        $or: [
          { ticketId: { $in: myTicketIds } },
          { vendorEmail: vendorEmail }, // Keep this for future-proofing
        ],
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ success: true, data: bookings });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
// GET bookings for vendor's tickets
app.get("/api/bookings/vendor/:vendorId", verifyToken, async (req, res) => {
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

// PUT update booking status
app.put("/api/bookings/:id/status", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    // Use updateOne instead of findOneAndUpdate to avoid "result.value" confusion
    const result = await bookingCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          status,
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    res.json({
      success: true,
      message: `Booking ${status} successfully`,
    });
  } catch (error) {
    console.error("Error updating booking:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

//  
// STRIPE PAYMENT ROUTES
//  

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

    // Prevent creating payment session if departure has already passed
    const departureDateTime = new Date(
      booking.departureDate + " " + booking.departureTime
    );
    if (isNaN(departureDateTime.getTime()) || departureDateTime <= new Date()) {
      return res.status(400).json({
        success: false,
        message:
          "Cannot pay for a booking whose departure date/time has already passed",
      });
    }

    // Prevent duplicate payments
    if (booking.status === "paid") {
      return res.status(400).json({
        success: false,
        message: "Booking is already paid",
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

      if (!booking) {
        return res
          .status(404)
          .json({ success: false, message: "Booking not found" });
      }

      // If already processed, return early
      if (booking.status === "paid") {
        return res
          .status(200)
          .json({ success: true, message: "Payment already processed" });
      }

      // Attempt to atomically decrement ticket quantity only if enough seats are available
      const ticketUpdate = await ticketsCollection.findOneAndUpdate(
        {
          _id: new ObjectId(booking.ticketId),
          ticketQuantity: { $gte: booking.bookingQuantity },
        },
        { $inc: { ticketQuantity: -booking.bookingQuantity } },
        { returnDocument: "after" }
      );

      if (!ticketUpdate.value) {
        // Insufficient seats: record failed transaction and mark booking for review
        await transactionsCollection.insertOne({
          transactionId: session.payment_intent || null,
          userId: booking.userId,
          bookingId: bookingId,
          ticketTitle: booking.ticketTitle,
          amount: booking.totalPrice,
          paymentDate: new Date(),
          paymentMethod: "card",
          status: "failed",
          note: "Insufficient tickets to fulfill booking",
          createdAt: new Date(),
        });

        await bookingCollection.updateOne(
          { _id: new ObjectId(bookingId) },
          {
            $set: {
              status: "payment_failed",
              transactionId: session.payment_intent || null,
              paymentDate: new Date(),
              updatedAt: new Date(),
            },
          }
        );

        return res.status(409).json({
          success: false,
          message:
            "Payment completed but not enough tickets are available to fulfill booking. Support will contact you for next steps.",
        });
      }

      // Update booking to paid
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
    // Ensure authenticated user is requesting their own transactions
    const authUser = await usersCollection.findOne({ email: req.tokenEmail });
    if (!authUser) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    if (authUser._id.toString() !== req.params.userId) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: cannot access other user's transactions",
      });
    }

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

//  
// ADMIN ROUTES (PROTECTED)
//  

// GET all tickets
app.get("/api/admin/tickets", verifyToken, async (req, res) => {
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
app.put(
  "/api/admin/tickets/:id/status",
  verifyToken,

  async (req, res) => {
    try {
      const { status } = req.body;

      // Diagnostic: normalize and log id param
      let ticketIdParam = req.params.id;
      if (typeof ticketIdParam === "object" && ticketIdParam !== null) {
        ticketIdParam = ticketIdParam.$oid || ticketIdParam.toString();
      }
      if (typeof ticketIdParam === "string")
        ticketIdParam = ticketIdParam.trim();
      console.log(
        "🔍 PUT /api/admin/tickets/:id/status - id param:",
        JSON.stringify(ticketIdParam),
        "type:",
        typeof ticketIdParam
      );

      // Try ObjectId lookup first, then string lookup
      let ticketDoc = null;
      try {
        const docs = await ticketsCollection
          .find({ _id: new ObjectId(ticketIdParam) })
          .limit(1)
          .toArray();
        console.log("🔎 ObjectId lookup count:", docs.length);
        ticketDoc = docs[0] || null;
      } catch (e) {
        console.log("⚠ Invalid ObjectId or lookup failed:", e.message);
      }

      if (!ticketDoc) {
        const docs = await ticketsCollection
          .find({ _id: ticketIdParam })
          .limit(1)
          .toArray();
        console.log("🔎 string _id lookup count:", docs.length);
        ticketDoc = docs[0] || null;
      }

      if (!ticketDoc) {
        console.log(
          "❌ Ticket not found for id:",
          JSON.stringify(ticketIdParam)
        );
        return res
          .status(404)
          .json({ success: false, message: "Ticket not found" });
      }

      // Perform update with updateOne and fetch updated doc
      const filter = { _id: ticketDoc._id };
      const update = { $set: { status, updatedAt: new Date() } };

      const updateResult = await ticketsCollection.updateOne(filter, update);
      console.log("🔁 ticket updateOne result:", updateResult);

      if (updateResult.matchedCount === 0) {
        console.log("❌ update matched 0 for ticket filter:", filter);
        return res
          .status(500)
          .json({ success: false, message: "Failed to update ticket" });
      }

      const updatedDoc = await ticketsCollection.findOne(filter);

      res.json({
        success: true,
        message: `Ticket ${status} successfully`,
        data: updatedDoc,
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
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

      // Normalize id param
      let ticketIdParam = req.params.id;
      if (typeof ticketIdParam === "object" && ticketIdParam !== null) {
        ticketIdParam = ticketIdParam.$oid || ticketIdParam.toString();
      }
      if (typeof ticketIdParam === "string")
        ticketIdParam = ticketIdParam.trim();
      console.log(
        "🔍 PUT /api/admin/tickets/:id/advertise - id param:",
        JSON.stringify(ticketIdParam)
      );

      if (isAdvertised) {
        // When counting, try to use ObjectId if possible, otherwise string comparison
        let count = 0;
        try {
          count = await ticketsCollection.countDocuments({
            isAdvertised: true,
            _id: { $ne: new ObjectId(ticketIdParam) },
          });
          console.log("🔎 advertise count (using ObjectId):", count);
        } catch (e) {
          count = await ticketsCollection.countDocuments({
            isAdvertised: true,
            _id: { $ne: ticketIdParam },
          });
          console.log("🔎 advertise count (using string _id):", count);
        }

        if (count >= 6) {
          return res.status(400).json({
            success: false,
            message: "Maximum 6 tickets can be advertised at a time",
          });
        }
      }

      // Lookup ticket (ObjectId then string)
      let ticketDoc = null;
      try {
        const docs = await ticketsCollection
          .find({ _id: new ObjectId(ticketIdParam) })
          .limit(1)
          .toArray();
        console.log("🔎 ObjectId lookup count (advertise):", docs.length);
        ticketDoc = docs[0] || null;
      } catch (e) {
        console.log(
          "⚠ Invalid ObjectId or lookup failed (advertise):",
          e.message
        );
      }

      if (!ticketDoc) {
        const docs = await ticketsCollection
          .find({ _id: ticketIdParam })
          .limit(1)
          .toArray();
        console.log("🔎 string _id lookup count (advertise):", docs.length);
        ticketDoc = docs[0] || null;
      }

      if (!ticketDoc) {
        console.log(
          "❌ Ticket not found for id (advertise):",
          JSON.stringify(ticketIdParam)
        );
        return res
          .status(404)
          .json({ success: false, message: "Ticket not found" });
      }

      // Update
      const filter = { _id: ticketDoc._id };
      const update = { $set: { isAdvertised, updatedAt: new Date() } };
      const updateResult = await ticketsCollection.updateOne(filter, update);
      console.log("🔁 advertise updateOne result:", updateResult);

      if (updateResult.matchedCount === 0) {
        console.log("❌ advertise update matched 0 for filter:", filter);
        return res
          .status(500)
          .json({ success: false, message: "Failed to update advertisement" });
      }

      const updatedDoc = await ticketsCollection.findOne(filter);

      res.json({
        success: true,
        message: isAdvertised ? "Ticket advertised" : "Advertisement removed",
        data: updatedDoc,
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
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

      // Normalize id parameter in case it's sent as an object (e.g., { $oid: '...' })
      let userIdParam = req.params.id;
      if (typeof userIdParam === "object" && userIdParam !== null) {
        userIdParam = userIdParam.$oid || userIdParam.toString();
      }
      // Trim to remove accidental whitespace
      if (typeof userIdParam === "string") userIdParam = userIdParam.trim();

      console.log(
        "🔍 PUT /api/admin/users/:id/role - id param:",
        JSON.stringify(userIdParam),
        "type:",
        typeof userIdParam
      );

      // Try multiple lookup strategies for robustness
      let userToUpdate = null;
      try {
        const docs = await usersCollection
          .find({ _id: new ObjectId(userIdParam) })
          .limit(1)
          .toArray();
        console.log("🔎 ObjectId lookup result count:", docs.length);
        userToUpdate = docs[0] || null;
      } catch (e) {
        console.log("⚠ Invalid ObjectId or lookup failed:", e.message);
      }

      if (!userToUpdate) {
        const docs = await usersCollection
          .find({ _id: userIdParam })
          .limit(1)
          .toArray();
        console.log("🔎 string _id lookup result count:", docs.length);
        userToUpdate = docs[0] || null;
      }

      if (!userToUpdate) {
        const docs = await usersCollection
          .find({ email: userIdParam })
          .limit(1)
          .toArray();
        console.log("🔎 email lookup result count:", docs.length);
        userToUpdate = docs[0] || null;
      }

      if (!userToUpdate) {
        const docs = await usersCollection
          .find({ uid: userIdParam })
          .limit(1)
          .toArray();
        console.log("🔎 uid lookup result count:", docs.length);
        userToUpdate = docs[0] || null;
      }

      if (!userToUpdate) {
        console.log(
          "❌ User not found for id/email/uid:",
          JSON.stringify(userIdParam)
        );
        return res
          .status(404)
          .json({ success: false, message: "User not found" });
      }

      console.log("🔔 Matched user:", {
        _id: userToUpdate._id?.toString?.(),
        email: userToUpdate.email,
        uid: userToUpdate.uid,
      });

      // Use the found user's _id in the update (preserves stored type)
      const filter = { _id: userToUpdate._id };
      const update = { $set: { role, updatedAt: new Date() } };

      const updateResult = await usersCollection.updateOne(filter, update);
      console.log("🔁 updateOne result:", updateResult);

      if (updateResult.matchedCount === 0) {
        console.log(
          "❌ updateOne matched 0 documents for filter:",
          filter,
          "_id type:",
          userToUpdate._id?.constructor?.name
        );
        return res
          .status(500)
          .json({ success: false, message: "Failed to update user role" });
      }

      const updatedDoc = await usersCollection.findOne(filter);
      console.log("🔔 Updated doc:", {
        _id: updatedDoc?._id?.toString?.(),
        role: updatedDoc?.role,
      });

      res.json({
        success: true,
        message: `User role updated to ${role}`,
        data: updatedDoc,
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
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

      // Normalize id parameter in case it's sent as an object (e.g., { $oid: '...' })
      let userIdParam = req.params.id;
      if (typeof userIdParam === "object" && userIdParam !== null) {
        userIdParam = userIdParam.$oid || userIdParam.toString();
      }
      if (typeof userIdParam === "string") userIdParam = userIdParam.trim();

      console.log(
        "🔍 PUT /api/admin/users/:id/fraud - id param:",
        JSON.stringify(userIdParam),
        "type:",
        typeof userIdParam
      );

      // Try multiple lookup strategies for robustness
      let userToUpdate = null;
      try {
        const docs = await usersCollection
          .find({ _id: new ObjectId(userIdParam) })
          .limit(1)
          .toArray();
        console.log("🔎 ObjectId lookup result count:", docs.length);
        userToUpdate = docs[0] || null;
      } catch (e) {
        console.log("⚠ Invalid ObjectId or lookup failed:", e.message);
      }

      if (!userToUpdate) {
        const docs = await usersCollection
          .find({ _id: userIdParam })
          .limit(1)
          .toArray();
        console.log("🔎 string _id lookup result count:", docs.length);
        userToUpdate = docs[0] || null;
      }

      if (!userToUpdate) {
        const docs = await usersCollection
          .find({ email: userIdParam })
          .limit(1)
          .toArray();
        console.log("🔎 email lookup result count:", docs.length);
        userToUpdate = docs[0] || null;
      }

      if (!userToUpdate) {
        const docs = await usersCollection
          .find({ uid: userIdParam })
          .limit(1)
          .toArray();
        console.log("🔎 uid lookup result count:", docs.length);
        userToUpdate = docs[0] || null;
      }

      if (!userToUpdate) {
        console.log(
          "❌ User not found for id/email/uid:",
          JSON.stringify(userIdParam)
        );
        return res
          .status(404)
          .json({ success: false, message: "User not found" });
      }

      console.log("🔔 Matched user:", {
        _id: userToUpdate._id?.toString?.(),
        email: userToUpdate.email,
        uid: userToUpdate.uid,
      });

      // Use the found user's _id in the update (preserves stored type)
      const filter = { _id: userToUpdate._id };
      const update = { $set: { isFraud, updatedAt: new Date() } };

      const updateResult = await usersCollection.updateOne(filter, update);
      console.log("🔁 updateOne result:", updateResult);

      if (updateResult.matchedCount === 0) {
        console.log(
          "❌ updateOne matched 0 documents for filter:",
          filter,
          "_id type:",
          userToUpdate._id?.constructor?.name
        );
        return res
          .status(500)
          .json({ success: false, message: "Failed to update fraud status" });
      }

      const updatedDoc = await usersCollection.findOne(filter);

      if (isFraud) {
        // vendorId in tickets may be stored as string; ensure we update using string representation
        const vendorIdForTickets = userToUpdate._id?.toString
          ? userToUpdate._id.toString()
          : userToUpdate._id;
        const ticketUpdateResult = await ticketsCollection.updateMany(
          { vendorId: vendorIdForTickets },
          { $set: { status: "rejected" } }
        );
        console.log(
          "🔔 Updated tickets vendorId:",
          vendorIdForTickets,
          "ticketUpdateResult:",
          ticketUpdateResult
        );
      }

      console.log(
        "✅ Fraud status updated for:",
        userToUpdate._id,
        "=>",
        isFraud
      );
      res.json({
        success: true,
        message: isFraud ? "Vendor marked as fraud" : "Fraud status removed",
        data: updatedDoc,
      });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
);
//  
// ERROR HANDLING
//  

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
//  
// START SERVER
//  
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
