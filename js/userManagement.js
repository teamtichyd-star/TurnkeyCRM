// js/userManagement.js

import { 
  createUserWithEmailAndPassword 
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import { 
  doc, setDoc, serverTimestamp 
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// Function to add new user with role
export async function addNewUser(name, email, password, role) {
  try {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;

    await setDoc(doc(db, "users", user.uid), {
      name: name,
      email: email,
      role: role,
      createdAt: serverTimestamp()
    });

    alert("User created successfully!");
    return true;
  } catch (error) {
    console.error("Error creating user:", error);
    alert("Error: " + error.message);
    return false;
  }
}