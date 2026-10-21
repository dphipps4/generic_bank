-- The two lessons about naming a sign-in screen are retired: the Scout no longer names any page.
-- A page is known by its own title, as the site gives it, and a sign-in that a browser the site
-- knows meets in a shorter form is told apart by the fields it holds.

UPDATE "LessonVersion"
   SET state = 'retired',
       reason = 'Retired by a person: the Scout no longer names pages; each is known by its own title.'
 WHERE "lessonId" IN ('base-scout-sign-in-name', 'base-supervisor-sign-in-name');
