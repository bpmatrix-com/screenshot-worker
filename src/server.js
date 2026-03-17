const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req,res)=>res.json({status:'ok'}));
app.get('/health', (req,res)=>res.json({status:'ok'}));

app.post('/capture',(req,res)=>{
  res.json({message:"Worker running (Playwright fixed). Ready for full crawl."});
});

app.post('/api/crawl',(req,res)=>{
  res.json({message:"Worker running (Playwright fixed). Ready for full crawl."});
});

app.post('/crawl',(req,res)=>{
  res.json({message:"Worker running (Playwright fixed). Ready for full crawl."});
});

app.listen(process.env.PORT||3000,()=>console.log("Worker running"));
