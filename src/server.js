const express = require("express");
const cors = require("cors");
const registerSuaMusicaRoutes = require('./services/suamusica.js');


const downloadRoute = require("./routes/download");

const app = express();


registerSuaMusicaRoutes(app);


app.use(cors());
app.use(express.json());

app.use("/", downloadRoute);

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
});