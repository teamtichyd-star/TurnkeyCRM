export async function addNewUser(auth, db, name, email, password, role) {
    try {
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;

        await setDoc(doc(db, "users", user.email), {
            name: name,
            email: email,
            role: role,
            createdAt: serverTimestamp()
        });

        // Sign out the newly created user so admin stays logged in
        await auth.signOut();

        alert("User created successfully!");
        return true;
    } catch (error) {
        console.error("Error creating user:", error);
        alert("Error: " + error.message);
        return false;
    }
}