const express = require("express");
const cors = require('cors');
const app = express();
require('dotenv').config();

app.use(cors());
app.use(express.json());
const port = 5000;

const { MongoClient, ServerApiVersion } = require("mongodb");

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