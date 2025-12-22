/*
  normalize_vendorId.js
  One-time migration to ensure all tickets have vendorId stored as STRING.
  Usage: node scripts/normalize_vendorId.js
*/

const { MongoClient } = require("mongodb");
require("dotenv").config();

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI not set in environment");
  process.exit(1);
}

async function run() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db("MavenusDB");
    const tickets = db.collection("ticketsCollection");

    // Count ObjectId vendorId docs
    const objectIdCount = await tickets.countDocuments({
      vendorId: { $type: "objectId" },
    });
    console.log("Found vendorId with ObjectId type:", objectIdCount);

    if (objectIdCount > 0) {
      const r = await tickets.updateMany({ vendorId: { $type: "objectId" } }, [
        {
          $set: {
            vendorId: { $toString: "$vendorId" },
            updatedAt: new Date(),
          },
        },
      ]);
      console.log(
        "Updated ObjectId vendorId -> string. Matched:",
        r.matchedCount,
        "Modified:",
        r.modifiedCount
      );
    } else {
      console.log("No ObjectId vendorId values found.");
    }

    // Numeric types (int/double/long/decimal) -> convert to string as well
    const numericTypes = ["int", "double", "long", "decimal"];
    const numericCount = await tickets.countDocuments({
      vendorId: { $type: numericTypes },
    });
    console.log("Found vendorId with numeric types:", numericCount);

    if (numericCount > 0) {
      const r2 = await tickets.updateMany(
        { vendorId: { $type: numericTypes } },
        [
          {
            $set: {
              vendorId: { $toString: "$vendorId" },
              updatedAt: new Date(),
            },
          },
        ]
      );
      console.log(
        "Updated numeric vendorId -> string. Matched:",
        r2.matchedCount,
        "Modified:",
        r2.modifiedCount
      );
    }

    // Check for remaining non-string vendorId values
    const remaining = await tickets.countDocuments({
      vendorId: { $exists: true, $not: { $type: "string" } },
    });
    console.log("Remaining docs with non-string vendorId:", remaining);

    if (remaining > 0) {
      console.log("Listing up to 5 problematic docs for manual inspection:");
      const examples = await tickets
        .find({ vendorId: { $exists: true, $not: { $type: "string" } } })
        .limit(5)
        .toArray();
      examples.forEach((d) =>
        console.log(d._id, "vendorId:", d.vendorId, "type:", typeof d.vendorId)
      );
      console.log("Please inspect these and convert manually if needed.");
    } else {
      console.log("All vendorId values are strings now.");
    }
  } catch (err) {
    console.error(err);
  } finally {
    await client.close();
  }
}

run();
