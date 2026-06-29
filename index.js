const express = require("express");
const cors = require('cors');
const Stripe = require('stripe');

const app = express();
require('dotenv').config();

app.use(cors());
app.use(express.json());
const port = 5000;

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const uri = process.env.MONGODB_URI;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    
 const database = client.db("luminary_db");
 const ebooksCollection = database.collection('ebooks')
 const userCollection = database.collection('user')
 const transactionsCollection = database.collection('transaction')


 app.get('/api/ebooks', async(req, res) => {
  const result = await ebooksCollection.find().toArray()
  res.send(result)
 })


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

app.post('/api/ebooks', async(req,res) => {
  const ebook = req.body;
  const newEbook = {
    ...ebook,
    createdAt: new Date()
  }

  const result = await ebooksCollection.insertOne(newEbook);
  res.send(result);
})

// transaction 


app.post('/api/v1/payments/verify-status', async (req, res) => {
  try {
    const { session_id } = req.body;
    
    if (!session_id) {
      return res.status(400).json({ message: "Session ID is required" });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status === 'paid') {
      const { ebookId, buyerEmail, price } = session.metadata;

      // Duplicate check
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
        amount: parseFloat(price),
        paymentStatus: 'paid',
        createdAt: new Date()
      };
      
      await transactionsCollection.insertOne(transactionInfo);

      // Update Ebook Status
      await ebooksCollection.updateOne(
        { $or: [{ _id: ebookId }, { _id: new ObjectId(ebookId) }] },
        { $set: { status: 'Sold' } }
      );

      // Update User
      await userCollection.updateOne(
        { email: buyerEmail },
        { 
          $set: { 
            lastPurchaseAt: new Date(),
            
          },
          $push: { purchasedEbooks: ebookId }
        }
      );

      return res.status(200).json({ 
        success: true, 
        message: "Payment verified successfully." 
      });

    } else {
      return res.status(400).json({ success: false, message: 'Payment not completed.' });
    }
  } catch (error) {
    console.error("Verification Error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});
 
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } catch (error) {
    console.error(error);
  }
}

run().then(() => {
  app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
  });
}).catch(console.dir);


app.get("/", (req, res) => {
  res.send("Hello World!");
});
  