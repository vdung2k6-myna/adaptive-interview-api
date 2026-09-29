import "dotenv/config";

import { createApp } from "./app";

const PORT = process.env.PORT || 4000;

createApp().listen(PORT, () => {
  console.log(`Adaptive Interview API listening on port ${PORT}`);
});
