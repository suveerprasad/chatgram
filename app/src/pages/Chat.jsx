import { useState, useEffect, useRef } from 'react';
import {
  getFirestore,
  collection,
  query,
  where,
  orderBy,
  limit,
  addDoc,
  serverTimestamp,
  onSnapshot,
  deleteDoc,
  doc,
  writeBatch, getDoc, setDoc
} from 'firebase/firestore';
import { ref, onValue, off } from 'firebase/database';
import { auth, db, rtdb, genAI } from '../firebase/firebaseConfig';
import UsersList from '../components/UsersList';
import ChatHeader from '../components/ChatHeader';
import MessagesList from '../components/MessagesList';
import MessageInput from '../components/MessageInput';
import GroupSettingsModal from '../components/GroupSettingsModal';
import { useCloudinary } from '../hooks/useCloudinary';
import Sidebar from '../components/Sidebar';
import MainHeader from '../components/MainHeader';
import { usePresence } from '../hooks/usePresence';

export default function Chat() {
  const [users, setUsers] = useState([]);
  const [groups, setGroups] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [showGroupSettings, setShowGroupSettings] = useState(false);
  const [newMessage, setNewMessage] = useState('');
  const [messages, setMessages] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [currentUserData, setCurrentUserData] = useState(null);
  const [typingStatus, setTypingStatus] = useState({});
  const [userStatus, setUserStatus] = useState({});
  const [selectedAI, setSelectedAI] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [forwardingMessage, setForwardingMessage] = useState(null);
  const messagesEndRef = useRef(null);
  const { uploadFileToCloudinary } = useCloudinary();

  usePresence(rtdb);

  // Fetch users
  useEffect(() => {
    const q = query(collection(db, 'users'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const usersData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setUsers(usersData);
      if (auth.currentUser) {
        const current = usersData.find(u => u.uid === auth.currentUser.uid);
        setCurrentUserData(current);
      }
    });
    return () => unsubscribe();
  }, [db]);

  // Fetch groups
  useEffect(() => {
    if (!auth.currentUser) return;

    const q = query(
      collection(db, 'groups'),
      where('members', 'array-contains', auth.currentUser.uid)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const groupsData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setGroups(groupsData);
    });

    return () => unsubscribe();
  }, [db]);

  // Fetch messages
  useEffect(() => {
    let q;
    if (selectedUser) {
      const participants = [auth.currentUser.uid, selectedUser.uid].sort();
      q = query(
        collection(db, 'messages'),
        where('conversationId', '==', participants.join('_')),
        orderBy('timestamp', 'asc'),
        limit(50)
      );
    } else if (selectedGroup) {
      q = query(
        collection(db, 'messages'),
        where('groupId', '==', selectedGroup.id),
        orderBy('timestamp', 'asc'),
        limit(50)
      );
    } else if (selectedAI) {
      q = query(
        collection(db, 'aiMessages'),
        where('userId', '==', auth.currentUser?.uid),
        orderBy('timestamp', 'asc'),
        limit(50)
      );
    } else {
      setMessages([]);
      return;
    }

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const messagesData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        timestamp: doc.data().timestamp?.toDate(),
        isAI: doc.data().isAI || false
      }));
      setMessages(messagesData);
    });

    return () => unsubscribe();
  }, [db, selectedUser, selectedGroup, selectedAI]);

  // Track user status
  useEffect(() => {
    if (!selectedUser?.uid) return;

    const statusRef = ref(rtdb, `status/${selectedUser.uid}`);
    const unsubscribe = onValue(statusRef, (snapshot) => {
      const data = snapshot.val();
      setUserStatus(prev => ({
        ...prev,
        [selectedUser.uid]: {
          status: data?.status || 'offline',
          lastChanged: data?.lastChanged
        }
      }));
    });

    return () => off(statusRef);
  }, [selectedUser, rtdb]);

  // Track typing status
  useEffect(() => {
    if (!selectedUser?.uid) return;

    const typingRef = ref(rtdb, `typing/${selectedUser.uid}`);
    const unsubscribe = onValue(typingRef, (snapshot) => {
      setTypingStatus(prev => ({
        ...prev,
        [selectedUser.uid]: snapshot.val()
      }));
    });

    return () => off(typingRef);
  }, [selectedUser, rtdb]);

  // Scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if ((!newMessage.trim() && !selectedFile) || (!selectedUser && !selectedGroup && !selectedAI)) return;

    setLoading(true);
    try {
      let fileData = null;
      if (selectedFile) {
        const uploadResult = await uploadFileToCloudinary(selectedFile);
        fileData = {
          url: uploadResult.url,
          name: selectedFile.name,
          size: selectedFile.size,
          type: selectedFile.type,
          publicId: uploadResult.publicId,
          resourceType: uploadResult.resourceType
        };
      }

      if (selectedAI) {
        // Save user message to AI conversation
        const userMessage = {
          text: newMessage,
          timestamp: serverTimestamp(),
          userId: auth.currentUser.uid,
          isAI: false,
          fileData
        };
        await addDoc(collection(db, 'aiMessages'), userMessage);

        // Generate AI response using Google AI SDK
        setAiLoading(true);
        try {
          const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

          let prompt = newMessage;

          // Handle different file types for AI processing
          if (selectedFile && fileData) {
            if (selectedFile.type.startsWith('image/')) {
              // Convert image to base64 for Gemini
              const fetchResponse = await fetch(fileData.url);
              const blob = await fetchResponse.blob();
              const base64 = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result.split(',')[1]);
                reader.readAsDataURL(blob);
              });

              const result = await model.generateContent([
                prompt || "What do you see in this image?",
                {
                  inlineData: {
                    data: base64,
                    mimeType: blob.type
                  }
                }
              ]);

              const aiResponse = await result.response;
              const aiText = aiResponse.text();

              // Save AI response
              const aiMessage = {
                text: aiText,
                timestamp: serverTimestamp(),
                userId: auth.currentUser.uid,
                isAI: true
              };
              await addDoc(collection(db, 'aiMessages'), aiMessage);
            } else {
              // For non-image files, just acknowledge the file
              const aiMessage = {
                text: `I received your ${selectedFile.type.split('/')[0]} file "${selectedFile.name}". ${prompt ? `Regarding your message: ${prompt}` : 'How can I help you with this file?'}`,
                timestamp: serverTimestamp(),
                userId: auth.currentUser.uid,
                isAI: true
              };
              await addDoc(collection(db, 'aiMessages'), aiMessage);
            }
          } else {
            // Text only prompt
            const result = await model.generateContent(prompt);
            const aiResponse = await result.response;
            const aiText = aiResponse.text();

            // Save AI response
            const aiMessage = {
              text: aiText,
              timestamp: serverTimestamp(),
              userId: auth.currentUser.uid,
              isAI: true
            };
            await addDoc(collection(db, 'aiMessages'), aiMessage);
          }
        } catch (error) {
          console.error('AI Error:', error);

          // Save error message as AI response
          const errorMessage = {
            text: "Sorry, I encountered an error while processing your request. Please try again.",
            timestamp: serverTimestamp(),
            userId: auth.currentUser.uid,
            isAI: true,
            isError: true
          };
          await addDoc(collection(db, 'aiMessages'), errorMessage);
        }
        setAiLoading(false);
      } else {
        // Existing message handling for user/group chats
        const messageData = {
          text: newMessage,
          timestamp: serverTimestamp(),
          uid: auth.currentUser.uid,
          photoURL: currentUserData?.photoURL || null,
          displayName: currentUserData?.name || auth.currentUser.displayName || 'Unknown',
          fileData
        };

        if (selectedUser) {
          const participants = [auth.currentUser.uid, selectedUser.uid].sort();
          messageData.conversationId = participants.join('_');
          messageData.receiverId = selectedUser.uid;
        } else if (selectedGroup) {
          messageData.groupId = selectedGroup.id;
        }

        await addDoc(collection(db, 'messages'), messageData);
      }

      setNewMessage('');
      setSelectedFile(null);
    } catch (error) {
      console.error('Error sending message:', error);
      alert('Failed to send message');
    }
    setLoading(false);
  };

  const handleNavigate = (page) => {
    if (page === 'ai') {
      setSelectedAI(true);
      setSelectedUser(null);
      setSelectedGroup(null);
    } else {
      setSelectedAI(false);
    }
  };

  // Implement delete message handler
  const handleDeleteMessage = async (messageId, isAI) => {
    try {
      let messageRef;
      if (isAI) {
        messageRef = doc(db, 'aiMessages', messageId);
      } else {
        messageRef = doc(db, 'messages', messageId);
      }

      await deleteDoc(messageRef);
      // Optionally show success notification
    } catch (error) {
      console.error('Error deleting message:', error);
      // Show error notification
    }
  };

  // Implement forward message handler
  const handleForwardMessage = async (message, recipientIds) => {
  try {
    const db = getFirestore();
    const batch = writeBatch(db);
    
    for (const uid of recipientIds) {
      const participants = [auth.currentUser.uid, uid].sort();
      const conversationId = participants.join('_');
      
      // Create the message
      const newMessageRef = doc(collection(db, 'messages'));
      batch.set(newMessageRef, {
        text: message.text,
        uid: auth.currentUser.uid,
        timestamp: serverTimestamp(),
        forwarded: true,
        originalSender: message.uid || (message.isAI ? "AI" : "Unknown"),
        fileData: message.fileData || null,
        photoURL: currentUserData?.photoURL || null,
        displayName: currentUserData?.name || auth.currentUser.displayName || 'Unknown',
        conversationId: conversationId,
        receiverId: uid
      });

      // Create or update conversation metadata
      const convoRef = doc(db, 'conversations', conversationId);
      const convoData = {
        participants: participants,
        lastMessage: message.text || (message.fileData ? `📎 ${message.fileData.name}` : 'File'),
        lastMessageTimestamp: serverTimestamp(),
        unreadCount: { [uid]: 1 }
      };
      
      batch.set(convoRef, convoData, { merge: true });
    }

    await batch.commit();
    console.log('Messages forwarded successfully');
  } catch (error) {
    console.error('Error forwarding messages:', error);
    alert('Failed to forward message. Error: ' + error.message);
  }
};

  return (
    <div className="flex flex-col h-screen bg-gray-950 text-gray-100">
      <MainHeader />
      <div className="flex flex-1 overflow-hidden">
        <div className="w-19 bg-gray-800">
          <Sidebar
            currentUser={currentUserData}
            onNavigate={handleNavigate}
          />
        </div>

        <div className="flex flex-1 overflow-hidden">
          <UsersList
            users={users}
            groups={groups}
            selectedUser={selectedUser}
            selectedGroup={selectedGroup}
            onUserSelect={(user) => {
              setSelectedUser(user);
              setSelectedGroup(null);
              setSelectedAI(false);
            }}
            onGroupSelect={(group) => {
              setSelectedGroup(group);
              setSelectedUser(null);
              setSelectedAI(false);
            }}
            currentUserUid={auth.currentUser?.uid}
            messages={messages}
            onGroupCreate={(newGroup) => setGroups(prev => [...prev, newGroup])}
          />

          <div className="flex flex-col flex-1">
            <ChatHeader
              selectedUser={selectedUser}
              selectedGroup={selectedGroup}
              selectedAI={selectedAI}
              currentUser={currentUserData}
              onGroupSettings={() => setShowGroupSettings(true)}
              userStatus={userStatus}
              typingStatus={typingStatus}
            />

            <MessagesList
              messages={messages}
              users={users}
              currentUserUid={auth.currentUser?.uid}
              messagesEndRef={messagesEndRef}
              isGroup={!!selectedGroup}
              isAI={selectedAI}
              onDeleteMessage={handleDeleteMessage}
              onForwardMessage={handleForwardMessage}
            />

            {(selectedUser || selectedGroup || selectedAI) && (
              <MessageInput
                newMessage={newMessage}
                setNewMessage={setNewMessage}
                selectedFile={selectedFile}
                setSelectedFile={setSelectedFile}
                loading={loading || aiLoading}
                onSubmit={handleSubmit}
                onFileSelect={(e) => setSelectedFile(e.target.files[0])}
                selectedUser={selectedUser}
                rtdb={rtdb}
                isAI={selectedAI}
                aiLoading={aiLoading}
              />
            )}
          </div>
        </div>
      </div>

      {selectedGroup && showGroupSettings && (
        <GroupSettingsModal
          group={selectedGroup}
          users={users}
          currentUser={currentUserData}
          onClose={() => setShowGroupSettings(false)}
        />
      )}
    </div>
  );
}