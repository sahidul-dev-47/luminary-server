const express = require("express");
const cors = require('cors');
const app = express();
require('dotenv').config();

app.use(cors());
app.use(express.json());
const port = 5000;

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const uri = process.env.MONGODB_URI;

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