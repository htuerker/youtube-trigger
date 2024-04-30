
import { google } from "googleapis";
const youtube = google.youtube('v3');

youtube.videos.list({
  key: "AIzaSyCbFosxhgaKD-ccIhT2tWo4tOAIBl0RcEU",
}).then((response) => {
  const { data } = response;
  console.log(data);
}).catch(console.error);