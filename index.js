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

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS by Luminary Server'));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());

const uri = process.env.MONGODB_URI;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function connectDB() {
  try {
    await client.connect();
    console.log(" Successfully connected to MongoDB!");
  } catch (error) {
    console.error(" MongoDB Connection Error:", error);
  }
}
connectDB();

const database = client.db("luminary_db");
const ebooksCollection = database.collection('ebooks');
const userCollection = database.collection('user');
const transactionsCollection = database.collection('transaction');

// ====================== ROUTES ======================

app.get("/", (req, res) => {
  res.send("Luminary Server is Running Perfectly!");
});

// Get all ebooks
app.get('/api/ebooks', async (req, res) => {
  try {
    const result = await ebooksCollection.find().toArray();
    res.send(result);
  } catch (error) {
    res.status(500).json({ message: "Error fetching ebooks" });
  }
});

// Get single ebook
app.get('/api/ebooks/:id', async (req, res) => {
  try {
    const id = req.params.id;
    
    const result = await ebooksCollection.findOne({ 
      $or: [
        { _id: id },                    
        { _id: new ObjectId(id) }      
      ]
    });

    if (!result) {
      return res.status(404).json({ 
        message: "Ebook not found", 
        requestedId: id 
      });
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
    res.status(500).json({ message: "Error inserting ebook" });
  }
});

// === PAYMENT VERIFICATION ===
app.post('/api/v1/payments/verify-status', async (req, res) => {
  try {
    const { session_id } = req.body;
    
    console.log(" Verify Called with session_id:", session_id);

    if (!session_id) {
      return res.status(400).json({ message: "Session ID is required" });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id);
    console.log(" Stripe Session Metadata:", session.metadata);

    if (session.payment_status !== 'paid') {
      return res.status(400).json({ success: false, message: 'Payment not completed.' });
    }

    const { ebookId, buyerEmail, price, writerId } = session.metadata;

    if (!ebookId || !buyerEmail) {
      return res.status(400).json({ success: false, message: "Missing metadata" });
    }

    // Check already processed
    const isAlreadyProcessed = await transactionsCollection.findOne({ 
      transactionId: session.id 
    });

    if (isAlreadyProcessed) {
      console.log(" Already processed transaction");
      return res.status(200).json({ success: true, message: "Already processed." });
    }

    // === TRANSACTION INSERT ===
    const transactionInfo = {
      transactionId: session.id,
      ebookId,
      buyerEmail,
      writerId: writerId || "unknown",
      amount: parseFloat(price),
      paymentStatus: 'paid',
      createdAt: new Date()
    };
    
    const txResult = await transactionsCollection.insertOne(transactionInfo);
    console.log("Transaction Inserted:", txResult.insertedId);

    // === UPDATE EBOOK 
    const ebookQuery = {
      $or: [
        { _id: ebookId },
        { _id: new ObjectId(ebookId) }   
      ]
    };

    const ebookUpdate = await ebooksCollection.updateOne(
      ebookQuery,
      { 
        $inc: { soldCount: 1 },           
        $set: { 
          lastSoldAt: new Date(),
          
        } 
      }
    );

    console.log(" Ebook Update Result:", ebookUpdate);

    // === UPDATE BUYER ===
    const buyerUpdate = await userCollection.updateOne(
      { email: buyerEmail },
      { 
        $set: { lastPurchaseAt: new Date() },
        $push: { purchasedEbooks: ebookId }
      }
    );

    console.log(" Buyer Update Result:", buyerUpdate);

    return res.status(200).json({ 
      success: true, 
      message: "Payment verified and database updated successfully." 
    });

  } catch (error) {
    console.error(" VERIFICATION ERROR:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error", 
      error: error.message 
    });
  }
});

app.listen(port, () => {
  console.log(` Luminary server listening on port ${port}`);
});

module.exports = app;