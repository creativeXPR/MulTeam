# for hosting
{
  "hosting": {
    "site": "multeam",

    "public": "public",
    ...
  }
}

firebase deploy --only hosting:multeam

# firebase config 
// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDyiA-AvfOmUX8BTNRKVjpGO8veivKeSJc",
  authDomain: "c-xpr25.firebaseapp.com",
  projectId: "c-xpr25",
  storageBucket: "c-xpr25.firebasestorage.app",
  messagingSenderId: "560670758532",
  appId: "1:560670758532:web:27ec4fdff51d44003614d1",
  measurementId: "G-JE0ZVKXKMB"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

# database(cloud firestore) id
multeam

# UI/UX references
C:\Users\Extra\Documents\UIUX\1788604000549.jpg
C:\Users\Extra\Documents\UIUX\1788604000586.jpg