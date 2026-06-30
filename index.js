const express = require("express");
const cors = require('cors');
const Stripe = require('stripe');
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

const allowedOrigins = [
  "http://localhost:3000",
  "https://luminary-client.vercel.app"
];

// Middleware
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());

// Stripe Setup
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// MongoDB Setup (Serverless Friendly)
let client = null;
let database = null;
let ebooksCollection = null;
let userCollection = null;
let transactionsCollection = null;

const uri = process.env.MONGODB_URI;

async function connectDB() {
  try {
    if (!client) {
      client = new MongoClient(uri, {
        serverApi: {
          version: ServerApiVersion.v1,
          strict: true,
          deprecationErrors: true,
        },
      });

      await client.connect();
      console.log(" MongoDB Connected Successfully!");

      database = client.db("luminary_db");
      ebooksCollection = database.collection('ebooks');
      userCollection = database.collection('user');
      transactionsCollection = database.collection('transaction');
    }
    return database;
  } catch (error) {
    console.error("MongoDB Connection Error:", error);
    throw error;
  }
}

// ====================== ROUTES ======================

app.get("/", (req, res) => {
  res.send("Luminary Server is Running Perfectly!");
});

// Get all ebooks
app.get('/api/ebooks', async (req, res) => {
  try {
    await connectDB();
    const result = await ebooksCollection.find().toArray();
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error fetching ebooks" });
  }
});

// Get single ebook
app.get('/api/ebooks/:id', async (req, res) => {
  try {
    await connectDB();
    const id = req.params.id;
    const result = await ebooksCollection.findOne({ 
      $or: [
        { _id: id },
        { _id: new ObjectId(id) }
      ]
    });

    if (!result) {
      return res.status(404).json({ message: "Ebook not found" });
    }
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// Create ebook
app.post('/api/ebooks', async (req, res) => {
  try {
    await connectDB();
    const ebook = req.body;
    const newEbook = {
      ...ebook,
      status: "Available",
      soldCount: 0,
      createdAt: new Date()
    };

    const result = await ebooksCollection.insertOne(newEbook);
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error inserting ebook" });
  }
});

// === PAYMENT VERIFICATION (Main Fix) ===
app.post('/api/v1/payments/verify-status', async (req, res) => {
  try {
    const { session_id } = req.body;
    
    if (!session_id) {
      return res.status(400).json({ message: "Session ID is required" });
    }

    // Ensure DB connection before any operation
    await connectDB();

    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status !== 'paid') {
      return res.status(400).json({ success: false, message: 'Payment not completed.' });
    }

    const { ebookId, buyerEmail, price, writerId } = session.metadata;

    if (!ebookId || !buyerEmail) {
      return res.status(400).json({ success: false, message: "Missing metadata" });
    }

    // Check duplicate
    const isAlreadyProcessed = await transactionsCollection.findOne({ 
      transactionId: session.id 
    });

    if (isAlreadyProcessed) {
      return res.status(200).json({ success: true, message: "Already processed." });
    }

    // Insert Transaction
    const transactionInfo = {
      transactionId: session.id,
      ebookId,
      buyerEmail,
      writerId: writerId || "unknown",
      amount: parseFloat(price),
      paymentStatus: 'paid',
      createdAt: new Date()
    };
    
    await transactionsCollection.insertOne(transactionInfo);

    // Update Ebook
    await ebooksCollection.updateOne(
      { $or: [{ _id: ebookId }, { _id: new ObjectId(ebookId) }] },
      { 
        $inc: { soldCount: 1 },
        $set: { lastSoldAt: new Date() }
      }
    );

    // Update Buyer
    await userCollection.updateOne(
      { email: buyerEmail },
      { 
        $set: { lastPurchaseAt: new Date() },
        $push: { purchasedEbooks: ebookId }
      }
    );

    console.log(` Transaction saved for session: ${session.id}`);

    return res.status(200).json({ 
      success: true, 
      message: "Payment verified and database updated successfully." 
    });

  } catch (error) {
    console.error("VERIFICATION ERROR:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error", 
      error: error.message 
    });
  }
});

// Local vs Vercel
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Luminary server listening on port ${port}`);
  });
} else {
  console.log(" Vercel Serverless Mode");
}

module.exports = app;