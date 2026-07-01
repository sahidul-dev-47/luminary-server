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
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());

// Stripe Setup
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// MongoDB Setup
let client = null;
let database = null;
let ebooksCollection = null;
let userCollection = null;
let transactionsCollection = null;

const uri = process.env.MONGODB_URI;

async function connectDB() {
  try {
    if (!uri) {
      throw new Error("MONGODB_URI is not set in environment variables");
    }

    if (!client) {
      client = new MongoClient(uri, {
        serverApi: {
          version: ServerApiVersion.v1,
          strict: true,
          deprecationErrors: true,
        },
      });

      await client.connect();
      console.log("MongoDB Connected Successfully!");

      database = client.db("luminary_db");
      ebooksCollection = database.collection('ebooks');
      userCollection = database.collection('user');
      transactionsCollection = database.collection('transaction');
    }
    return database;
  } catch (error) {
    console.error("MongoDB Connection Error:", error.message);
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
      $or: [{ _id: id }, { _id: new ObjectId(id) }]
    });

    if (!result) return res.status(404).json({ message: "Ebook not found" });
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

// === PAYMENT VERIFICATION ===

app.post('/api/v1/payments/verify-status', async (req, res) => {
  try {
    const { session_id } = req.body;
    
    if (!session_id) {
      return res.status(400).json({ message: "Session ID is required" });
    }

    await connectDB();

    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status !== 'paid') {
      return res.status(400).json({ success: false, message: 'Payment not completed.' });
    }

    const { ebookId, buyerEmail, price, writerId, writerEmail } = session.metadata || {};

    if (!ebookId || !buyerEmail) {
      return res.status(400).json({ success: false, message: "Missing metadata from Stripe session" });
    }

    const isAlreadyProcessed = await transactionsCollection.findOne({ 
      transactionId: session.id 
    });

    if (isAlreadyProcessed) {
      return res.status(200).json({ success: true, message: "Already processed." });
    }

    const finalAmount = price ? parseFloat(price) : (session.amount_total ? session.amount_total / 100 : 0);

    // Insert Transaction with writer info
    const transactionInfo = {
      transactionId: session.id,
      ebookId,
      buyerEmail,
      writerId: writerId || "unknown",
      writerEmail: writerEmail || "unknown",   
      amount: finalAmount,
      paymentStatus: 'paid',
      createdAt: new Date()
    };
    
    await transactionsCollection.insertOne(transactionInfo);

    let mongoEbookId = ebookId;
    try {
      if (ObjectId.isValid(ebookId)) {
        mongoEbookId = new ObjectId(ebookId);
      }
    } catch (e) {}

    // Update Ebook
    await ebooksCollection.updateOne(
      { $or: [{ _id: ebookId }, { _id: mongoEbookId }] },
      { $inc: { soldCount: 1 }, $set: { lastSoldAt: new Date() } }
    );

    // Update Buyer
    await userCollection.updateOne(
      { email: buyerEmail },
      { 
        $set: { lastPurchaseAt: new Date() }, 
        $addToSet: { purchasedEbooks: ebookId } 
      }
    );

    console.log(`Transaction saved for writer: ${writerEmail}`);

    return res.status(200).json({ 
      success: true, 
      message: "Payment verified and database updated successfully." 
    });

  } catch (error) {
    console.error("VERIFICATION ERROR:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error during verification", 
      error: error.message 
    });
  }
});

// ==================== READER APIs ====================

// Get User's Purchase History
app.get('/api/v1/users/purchases', async (req, res) => {
  try {
    await connectDB();
    const { email } = req.query;

    if (!email) return res.status(400).json({ success: false, message: "Email is required" });

    const purchases = await transactionsCollection
      .find({ buyerEmail: email })
      .sort({ createdAt: -1 })
      .toArray();

    const purchasesWithDetails = await Promise.all(
      purchases.map(async (purchase) => {
        const ebook = await ebooksCollection.findOne({
          $or: [{ _id: purchase.ebookId }, { _id: new ObjectId(purchase.ebookId) }]
        });
        return {
          ...purchase,
          ebookTitle: ebook?.title || "Ebook Not Found",
          ebookCover: ebook?.coverImage || null,
          writerId: ebook?.writerId || purchase.writerId,
        };
      })
    );

    res.json({ success: true, purchases: purchasesWithDetails });
  } catch (error) {
    console.error("Purchase History Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Get User's Bookmarks
app.get('/api/v1/users/bookmarks', async (req, res) => {
  try {
    await connectDB();
    const { email } = req.query;

    if (!email) return res.status(400).json({ success: false, message: "Email is required" });

    const user = await userCollection.findOne({ email });

    if (!user || !user.bookmarks || user.bookmarks.length === 0) {
      return res.json({ success: true, bookmarks: [] });
    }

    const bookmarks = await ebooksCollection
      .find({ _id: { $in: user.bookmarks } })
      .toArray();

    res.json({
      success: true,
      bookmarks: bookmarks.map(book => ({
        ebookId: book._id,
        ebookTitle: book.title,
        ebookCover: book.coverImage,
        writerName: book.writerName || "Unknown Writer",
        price: book.price
      }))
    });

  } catch (error) {
    console.error("Bookmarks Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ==================== NEW: BOOKMARK TOGGLE ====================
app.post('/api/v1/users/bookmark', async (req, res) => {
  try {
    await connectDB();
    const { email, ebookId } = req.body;

    if (!email || !ebookId) {
      return res.status(400).json({
        success: false,
        message: "Email and ebookId are required"
      });
    }

    const user = await userCollection.findOne({ email });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const isAlreadyBookmarked = (user.bookmarks || []).includes(ebookId);

    if (isAlreadyBookmarked) {
      await userCollection.updateOne(
        { email },
        { $pull: { bookmarks: ebookId } }
      );
    } else {
      await userCollection.updateOne(
        { email },
        { $addToSet: { bookmarks: ebookId } }
      );
    }

    res.json({
      success: true,
      message: isAlreadyBookmarked ? "Bookmark removed" : "Bookmark saved successfully",
      bookmarked: !isAlreadyBookmarked
    });

  } catch (error) {
    console.error("Bookmark Error:", error);
    res.status(500).json({
      success: false,
      message: "Server error while saving bookmark"
    });
  }
});

// Get User Profile
app.get('/api/v1/users/profile', async (req, res) => {
  try {
    await connectDB();
    const { email } = req.query;

    if (!email) return res.status(400).json({ success: false, message: "Email is required" });

    const userData = await userCollection.findOne({ email }, { projection: { password: 0 } });

    if (!userData) return res.status(404).json({ success: false, message: "User not found" });

    res.json({ success: true, user: userData });
  } catch (error) {
    console.error("Profile Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Update User Profile
app.put('/api/v1/users/profile', async (req, res) => {
  try {
    await connectDB();
    const { email, name, ...updateData } = req.body;

    if (!email) return res.status(400).json({ success: false, message: "Email is required" });

    const result = await userCollection.updateOne({ email }, { $set: updateData });

    if (result.modifiedCount === 0) {
      return res.status(400).json({ success: false, message: "No changes made" });
    }

    res.json({ success: true, message: "Profile updated successfully" });
  } catch (error) {
    console.error("Update Profile Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ==================== WRITER APIs ====================

// Get all ebooks 
app.get('/api/v1/writer/ebooks', async (req, res) => {
  try {
    await connectDB();
    const { writerId } = req.query;

    if (!writerId) return res.status(400).json({ success: false, message: "writerId is required" });

    const ebooks = await ebooksCollection
      .find({ writerId })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ success: true, ebooks });
  } catch (error) {
    console.error("Writer Ebooks Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Get a single writer
app.get('/api/v1/writer/ebooks/:id', async (req, res) => {
  try {
    await connectDB();
    const { id } = req.params;
    const { writerId } = req.query;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid ebook id" });
    }

    const ebook = await ebooksCollection.findOne({ _id: new ObjectId(id) });

    if (!ebook) return res.status(404).json({ success: false, message: "Ebook not found" });
    if (writerId && ebook.writerId !== writerId) {
      return res.status(403).json({ success: false, message: "Not authorized to view this ebook" });
    }

    res.json({ success: true, ebook });
  } catch (error) {
    console.error("Get Writer Ebook Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Create a new ebook as a writer
app.post('/api/v1/writer/ebooks', async (req, res) => {
  try {
    await connectDB();
    const { title, description, price, genre, coverImage, writerId, writerEmail, writerName } = req.body;

    if (!title || !price || !genre || !writerId) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    const newEbook = {
      title,
      description: description || "",
      price: parseFloat(price),
      genre,
      coverImage: coverImage || null,
      writerId,                  
      writerEmail: writerEmail || writerId,   
      writerName: writerName || "Unknown Writer",
      status: "Unpublished",       
      soldCount: 0,
      createdAt: new Date(),
    };

    const result = await ebooksCollection.insertOne(newEbook);
    res.status(201).json({
      success: true,
      message: "Ebook created successfully as Unpublished",
      ebookId: result.insertedId,
    });
  } catch (error) {
    console.error("Create Ebook Error:", error);
    res.status(500).json({ success: false, message: "Server error while creating ebook" });
  }
});
// Update an ebook 
app.put('/api/v1/writer/ebooks/:id', async (req, res) => {
  try {
    await connectDB();
    const { id } = req.params;
    const { writerId, title, description, price, genre, coverImage } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid ebook id" });
    }

    const existing = await ebooksCollection.findOne({ _id: new ObjectId(id) });
    if (!existing) return res.status(404).json({ success: false, message: "Ebook not found" });
    if (existing.writerId !== writerId) {
      return res.status(403).json({ success: false, message: "Not authorized to edit this ebook" });
    }

    const updateFields = {
      ...(title && { title }),
      ...(description && { description }),
      ...(price && { price: parseFloat(price) }),
      ...(genre && { genre }),
      ...(coverImage && { coverImage }),
      updatedAt: new Date(),
    };

    await ebooksCollection.updateOne({ _id: new ObjectId(id) }, { $set: updateFields });
    res.json({ success: true, message: "Ebook updated successfully" });
  } catch (error) {
    console.error("Update Ebook Error:", error);
    res.status(500).json({ success: false, message: "Server error while updating ebook" });
  }
});

// Toggle publish 
app.patch('/api/v1/writer/ebooks/:id/toggle-status', async (req, res) => {
  try {
    await connectDB();
    const { id } = req.params;
    const { writerId } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid ebook id" });
    }

    const existing = await ebooksCollection.findOne({ _id: new ObjectId(id) });
    if (!existing) return res.status(404).json({ success: false, message: "Ebook not found" });
    if (existing.writerId !== writerId) {
      return res.status(403).json({ success: false, message: "Not authorized to update this ebook" });
    }

    const newStatus = existing.status === "Published" ? "Unpublished" : "Published";
    await ebooksCollection.updateOne({ _id: new ObjectId(id) }, { $set: { status: newStatus } });

    res.json({ success: true, message: `Ebook ${newStatus.toLowerCase()}`, status: newStatus });
  } catch (error) {
    console.error("Toggle Status Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});


app.delete('/api/v1/writer/ebooks/:id', async (req, res) => {
  try {
    await connectDB();
    const { id } = req.params;
    const { writerId } = req.query;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid ebook id" });
    }

    const existing = await ebooksCollection.findOne({ _id: new ObjectId(id) });
    if (!existing) return res.status(404).json({ success: false, message: "Ebook not found" });
    if (writerId && existing.writerId !== writerId) {
      return res.status(403).json({ success: false, message: "Not authorized to delete this ebook" });
    }

    await ebooksCollection.deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true, message: "Ebook deleted successfully" });
  } catch (error) {
    console.error("Delete Ebook Error:", error);
    res.status(500).json({ success: false, message: "Server error while deleting ebook" });
  }
});

// ==================== WRITER BOOKMARK ====================

// Toggle Bookmark for Writer
app.post('/api/v1/writer/bookmark', async (req, res) => {
  try {
    await connectDB();
    const { email, ebookId } = req.body;   

    if (!email || !ebookId) {
      return res.status(400).json({
        success: false,
        message: "Email and ebookId are required"
      });
    }

    const user = await userCollection.findOne({ email });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const isAlreadyBookmarked = (user.bookmarks || []).includes(ebookId);

    if (isAlreadyBookmarked) {
      await userCollection.updateOne(
        { email },
        { $pull: { bookmarks: ebookId } }
      );
    } else {
      await userCollection.updateOne(
        { email },
        { $addToSet: { bookmarks: ebookId } }
      );
    }

    res.json({
      success: true,
      message: isAlreadyBookmarked ? "Bookmark removed" : "Bookmark saved successfully",
      bookmarked: !isAlreadyBookmarked
    });

  } catch (error) {
    console.error("Writer Bookmark Error:", error);
    res.status(500).json({
      success: false,
      message: "Server error while saving bookmark"
    });
  }
});

// Get Writer's Bookmarks
app.get('/api/v1/writer/bookmarks', async (req, res) => {
  try {
    await connectDB();
    const { email } = req.query;

    if (!email) return res.status(400).json({ success: false, message: "Email is required" });

    const user = await userCollection.findOne({ email });

    if (!user || !user.bookmarks || user.bookmarks.length === 0) {
      return res.json({ success: true, bookmarks: [] });
    }

    const bookmarks = await ebooksCollection
      .find({ _id: { $in: user.bookmarks } })
      .toArray();

    res.json({
      success: true,
      bookmarks: bookmarks.map(book => ({
        ebookId: book._id,
        ebookTitle: book.title,
        ebookCover: book.coverImage,
        writerName: book.writerName || "Unknown Writer",
        writerEmail: book.writerEmail || "unknown Email" ,
        price: book.price,
        status: book.status
      }))
    });

  } catch (error) {
    console.error("Writer Bookmarks Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});



app.get('/api/v1/writer/sales', async (req, res) => {
  try {
    await connectDB();
    const { writerId, writerEmail } = req.query;

    if (!writerId && !writerEmail) {
      return res.status(400).json({ 
        success: false, 
        message: "writerId or writerEmail is required" 
      });
    }

    // Flexible query - duitai support korbe
    const query = {};
    if (writerId) query.writerId = writerId;
    if (writerEmail) query.writerEmail = writerEmail;

    const sales = await transactionsCollection
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    const salesWithDetails = await Promise.all(
      sales.map(async (sale) => {
        let ebook = null;
        if (ObjectId.isValid(sale.ebookId)) {
          ebook = await ebooksCollection.findOne({ _id: new ObjectId(sale.ebookId) });
        }
        return {
          ...sale,
          ebookTitle: ebook?.title || "Ebook Not Found",
          ebookCover: ebook?.coverImage || null,
        };
      })
    );

    res.json({ success: true, sales: salesWithDetails });
  } catch (error) {
    console.error("Writer Sales Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get('/api/v1/writer/analytics', async (req, res) => {
  try {
    await connectDB();
    const { writerId } = req.query;

    if (!writerId) return res.status(400).json({ success: false, message: "writerId is required" });

    const ebooks = await ebooksCollection.find({ writerId }).toArray();
    const sales = await transactionsCollection.find({ writerId }).toArray();

    const totalEbooks = ebooks.length;
    const publishedCount = ebooks.filter((e) => e.status === "Published").length;
    const unpublishedCount = totalEbooks - publishedCount;
    const totalSold = sales.length;
    const totalRevenue = sales.reduce((sum, s) => sum + (s.amount || 0), 0);

    const genreBreakdown = ebooks.reduce((acc, e) => {
      acc[e.genre] = (acc[e.genre] || 0) + 1;
      return acc;
    }, {});

    res.json({
      success: true,
      analytics: {
        totalEbooks,
        publishedCount,
        unpublishedCount,
        totalSold,
        totalRevenue,
        genreBreakdown,
      },
    });
  } catch (error) {
    console.error("Writer Analytics Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Local vs Vercel
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Luminary server listening on port ${port}`);
  });
} else {
  console.log("Vercel Serverless Mode - Ready");
}

module.exports = app;