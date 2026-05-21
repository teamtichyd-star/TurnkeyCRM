import { createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

export async function addNewUser(auth, db, name, email, password, role) {
    try {
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const newUser = userCredential.user;

        await setDoc(doc(db, "users", email), {
            name: name,
            email: email,
            role: role,
            createdAt: serverTimestamp()
        });

        await auth.signOut();

        alert("User created successfully!");
        return true;

    } catch (error) {
        console.error("Error:", error);
        alert("Error: " + error.message);
        return false;
    }
}